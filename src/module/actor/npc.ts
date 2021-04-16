import { ActorPF2e, SKILL_DICTIONARY, SKILL_EXPANDED } from './base';
import { ItemPF2e } from '@item/base';
import { CheckModifier, ModifierPF2e, MODIFIER_TYPE, StatisticModifier, ensureProficiencyOption } from '../modifiers';
import { PF2WeaponDamage } from '../system/damage/weapon';
import { CheckPF2e, PF2DamageRoll } from '../system/rolls';
import { AbilityString, Attitude, CharacterStrikeTrait, NPCData, NPCStrike, ZeroToThree } from './data-definitions';
import { RuleElements } from '../rules/rules';
import { PF2RollNote } from '../notes';
import { adaptRoll } from '@system/rolls';
import { CreaturePF2e } from '@actor/creature';
import { ConfigPF2e } from '@scripts/config';
import { ActionData, MeleeData, Rarity, SpellAttackRollModifier, SpellDifficultyClass } from '@item/data-definitions';

export class NPCPF2e extends CreaturePF2e {
    get rarity(): Rarity {
        return this.data.data.traits.rarity.value;
    }

    /** Does this NPC have the Elite adjustment? */
    get isElite(): boolean {
        return this.traits.has('elite');
    }

    /** Does this NPC have the Weak adjustment? */
    get isWeak(): boolean {
        return this.traits.has('weak');
    }

    /**
     *  Users with limited permission can loot a dead NPC
     * @override
     */
    static can(user: User, action: UserAction, target: NPCPF2e): boolean {
        const npcsAreLootable = game.settings.get('pf2e', 'automation.lootableNPCs');
        if (action === 'update' && target.hitPoints.current === 0 && npcsAreLootable) {
            return target.permission >= CONST.ENTITY_PERMISSIONS.LIMITED;
        }
        return super.can(user, action, target);
    }

    /**
     * A user can see an NPC in the actor directory only if they have at least Observer permission
     * @override
     */
    get visible(): boolean {
        return this.permission >= CONST.ENTITY_PERMISSIONS.OBSERVER;
    }

    /**
     * Grant all users at least limited permission on dead NPCs
     * @override
     */
    get permission(): ZeroToThree {
        const npcsAreLootable = game.settings.get('pf2e', 'automation.lootableNPCs');
        if (game.user.isGM || this.hitPoints.current > 0 || !npcsAreLootable) {
            return super.permission;
        }
        return Math.max(super.permission, 1) as ZeroToThree;
    }

    /**
     * Grant players limited permission on dead NPCs
     * @override
     */
    hasPerm(user: User, permission: string | ZeroToThree, exact = false) {
        // Temporary measure until a lootable view of the legacy sheet is ready
        const npcsAreLootable = game.settings.get('pf2e', 'automation.lootableNPCs');
        if (game.user.isGM || this.hitPoints.current > 0 || !npcsAreLootable) {
            return super.hasPerm(user, permission, exact);
        }
        if ([1, 'LIMITED'].includes(permission) && !exact) {
            return this.permission >= CONST.ENTITY_PERMISSIONS.LIMITED;
        }
        return super.hasPerm(user, permission, exact);
    }

    /** Prepare Character type specific data. */
    prepareDerivedData(): void {
        super.prepareDerivedData();
        const actorData = this.data;
        const { data } = actorData;

        // Add rarity and custom traits to main trait list
        const traits = this.data.data.traits;
        const rarity = traits.rarity.value;
        const customTraits = traits.traits.custom.split(/\s*[,;|]\s*/).filter((trait) => trait);
        const traitSet = new Set(traits.traits.value.concat(rarity).concat(customTraits));
        traits.traits.value = Array.from(traitSet).sort();

        const rules = actorData.items.reduce(
            (accumulated, current) => accumulated.concat(RuleElements.fromOwnedItem(current)),
            [],
        );

        // Toggles
        (data as any).toggles = {
            actions: [
                {
                    label: 'PF2E.TargetFlatFootedLabel',
                    inputName: `flags.${game.system.id}.rollOptions.all.target:flatFooted`,
                    checked: this.getFlag(game.system.id, 'rollOptions.all.target:flatFooted'),
                },
            ],
        };

        const { statisticsModifiers, damageDice, strikes, rollNotes } = this._prepareCustomModifiers(actorData, rules);

        if (this.isElite) {
            statisticsModifiers.all = statisticsModifiers.all ?? [];
            statisticsModifiers.all.push(new ModifierPF2e('PF2E.NPC.Adjustment.EliteLabel', 2, MODIFIER_TYPE.UNTYPED));
            statisticsModifiers.damage = statisticsModifiers.damage ?? [];
            statisticsModifiers.damage.push(
                new ModifierPF2e('PF2E.NPC.Adjustment.EliteLabel', 2, MODIFIER_TYPE.UNTYPED),
            );
            statisticsModifiers.hp = statisticsModifiers.hp ?? [];
            statisticsModifiers.hp.push(
                new ModifierPF2e(
                    'PF2E.NPC.Adjustment.EliteLabel',
                    this.getHpAdjustment(data.details.level.value),
                    MODIFIER_TYPE.UNTYPED,
                ),
            );
        } else if (this.isWeak) {
            statisticsModifiers.all = statisticsModifiers.all ?? [];
            statisticsModifiers.all.push(new ModifierPF2e('PF2E.NPC.Adjustment.WeakLabel', -2, MODIFIER_TYPE.UNTYPED));
            statisticsModifiers.damage = statisticsModifiers.damage ?? [];
            statisticsModifiers.damage.push(
                new ModifierPF2e('PF2E.NPC.Adjustment.WeakLabel', -2, MODIFIER_TYPE.UNTYPED),
            );
            statisticsModifiers.hp = statisticsModifiers.hp ?? [];
            statisticsModifiers.hp.push(
                new ModifierPF2e(
                    'PF2E.NPC.Adjustment.WeakLabel',
                    this.getHpAdjustment(data.details.level.value) * -1,
                    MODIFIER_TYPE.UNTYPED,
                ),
            );
        }

        // Compute 'fake' ability scores from ability modifiers (just in case the scores are required for something)
        for (const abl of Object.values(actorData.data.abilities)) {
            abl.mod = Number(abl.mod ?? 0); // ensure the modifier is never a string
            abl.value = abl.mod * 2 + 10;
        }

        // Hit Points
        {
            const base: number = data.attributes.hp.base ?? data.attributes.hp.value;
            const modifiers: ModifierPF2e[] = [];
            (statisticsModifiers.hp || []).map((m) => duplicate(m)).forEach((m) => modifiers.push(m));
            (statisticsModifiers['hp-per-level'] || [])
                .map((m) => duplicate(m))
                .forEach((m) => {
                    m.modifier *= data.details.level.value;
                    modifiers.push(m);
                });

            const stat = mergeObject(new StatisticModifier('hp', modifiers), data.attributes.hp, {
                overwrite: false,
            });

            stat.base = base;
            stat.max = stat.max + stat.totalModifier;
            stat.value = Math.min(stat.value, stat.max); // Make sure the current HP isn't higher than the max HP
            stat.breakdown = [
                game.i18n.format('PF2E.MaxHitPointsBaseLabel', { base }),
                ...stat.modifiers
                    .filter((m) => m.enabled)
                    .map((m) => `${game.i18n.localize(m.name)} ${m.modifier < 0 ? '' : '+'}${m.modifier}`),
            ].join(', ');

            data.attributes.hp = stat;
        }

        // Speeds
        {
            const label = game.i18n.localize('PF2E.SpeedTypesLand');
            const base = parseInt(data.attributes.speed.value, 10) || 0;
            const modifiers: ModifierPF2e[] = [];
            ['land-speed', 'speed'].forEach((key) => {
                (statisticsModifiers[key] || []).map((m) => duplicate(m)).forEach((m) => modifiers.push(m));
            });
            const stat = mergeObject(
                new StatisticModifier(game.i18n.format('PF2E.SpeedLabel', { type: label }), modifiers),
                data.attributes.speed,
                { overwrite: false },
            );
            stat.total = base + stat.totalModifier;
            stat.type = 'land';
            stat.breakdown = [`${game.i18n.format('PF2E.SpeedBaseLabel', { type: label })} ${base}`]
                .concat(
                    stat.modifiers
                        .filter((m) => m.enabled)
                        .map((m) => `${game.i18n.localize(m.name)} ${m.modifier < 0 ? '' : '+'}${m.modifier}`),
                )
                .join(', ');
            data.attributes.speed = stat;
        }
        for (let idx = 0; idx < data.attributes.speed.otherSpeeds.length; idx++) {
            const speed = data.attributes.speed.otherSpeeds[idx];
            const base = typeof speed.value === 'string' ? parseInt(speed.value, 10) || 0 : 0;
            const modifiers: ModifierPF2e[] = [];
            [`${speed.type.toLowerCase()}-speed`, 'speed'].forEach((key) => {
                (statisticsModifiers[key] || []).map((m) => duplicate(m)).forEach((m) => modifiers.push(m));
            });
            const stat = mergeObject(
                new StatisticModifier(game.i18n.format('PF2E.SpeedLabel', { type: speed.type }), modifiers),
                speed,
                { overwrite: false },
            );
            stat.total = base + stat.totalModifier;
            stat.breakdown = [`${game.i18n.format('PF2E.SpeedBaseLabel', { type: speed.type })} ${base}`]
                .concat(
                    stat.modifiers
                        .filter((m) => m.enabled)
                        .map((m) => `${game.i18n.localize(m.name)} ${m.modifier < 0 ? '' : '+'}${m.modifier}`),
                )
                .join(', ');
            data.attributes.speed.otherSpeeds[idx] = stat;
        }

        // Armor Class
        {
            const base: number = data.attributes.ac.base ?? Number(data.attributes.ac.value);
            const dexterity = Math.min(
                data.abilities.dex.mod,
                ...(data.attributes.dexCap ?? []).map((cap) => cap.value),
            );
            const modifiers = [
                new ModifierPF2e('PF2E.BaseModifier', base - 10 - dexterity, MODIFIER_TYPE.UNTYPED),
                new ModifierPF2e(CONFIG.PF2E.abilities.dex, dexterity, MODIFIER_TYPE.ABILITY),
            ];

            ['ac', 'dex-based', 'all'].forEach((key) => {
                (statisticsModifiers[key] || []).map((m) => duplicate(m)).forEach((m) => modifiers.push(m));
            });

            const stat = mergeObject(new StatisticModifier('ac', modifiers), data.attributes.ac, {
                overwrite: false,
            });
            stat.base = base;
            stat.value = 10 + stat.totalModifier;
            stat.breakdown = [game.i18n.localize('PF2E.ArmorClassBase')]
                .concat(
                    stat.modifiers
                        .filter((m) => m.enabled)
                        .map((m) => `${game.i18n.localize(m.name)} ${m.modifier < 0 ? '' : '+'}${m.modifier}`),
                )
                .join(', ');

            data.attributes.ac = stat;
        }

        // Shield
        {
            const shield = this.getFirstEquippedShield();
            if (shield) {
                // Use shield item data
                const isBroken = shield.data.hp.value <= shield.data.brokenThreshold.value;
                const shieldData = {
                    value: shield.data.hp.value,
                    max: shield.data.maxHp.value,
                    ac: isBroken ? 0 : shield.data.armor.value,
                    hardness: shield.data.hardness.value,
                    brokenThreshold: shield.data.brokenThreshold.value,
                };
                data.attributes.shield = shieldData;
            } else {
                if (!data.attributes.shield.max) {
                    // No shield and no existing data
                    const shieldData = {
                        value: 0,
                        max: 0,
                        ac: 0,
                        hardness: 0,
                        brokenThreshold: 0,
                    };
                    data.attributes.shield = shieldData;
                } else {
                    // Use existing data
                    const isBroken =
                        Number(data.attributes.shield.value) <= Number(data.attributes.shield.brokenThreshold);
                    if (isBroken) {
                        data.attributes.shield.ac = 0;
                    }
                }
            }
        }

        // Saving Throws
        for (const [saveName, save] of Object.entries(data.saves as Record<string, any>)) {
            const base: number = save.base ?? Number(save.value);
            const modifiers = [
                new ModifierPF2e('PF2E.BaseModifier', base - data.abilities[save.ability].mod, MODIFIER_TYPE.UNTYPED),
                new ModifierPF2e(
                    CONFIG.PF2E.abilities[save.ability],
                    data.abilities[save.ability].mod,
                    MODIFIER_TYPE.ABILITY,
                ),
            ];
            const notes = [] as PF2RollNote[];
            [saveName, `${save.ability}-based`, 'saving-throw', 'all'].forEach((key) => {
                (statisticsModifiers[key] || []).map((m) => duplicate(m)).forEach((m) => modifiers.push(m));
                (rollNotes[key] ?? []).map((n) => duplicate(n)).forEach((n) => notes.push(n));
            });

            const stat = mergeObject(new StatisticModifier(saveName, modifiers), save, {
                overwrite: false,
            });
            stat.base = base;
            stat.value = stat.totalModifier;
            stat.breakdown = stat.modifiers
                .filter((m) => m.enabled)
                .map((m) => `${game.i18n.localize(m.name)} ${m.modifier < 0 ? '' : '+'}${m.modifier}`)
                .join(', ');
            stat.roll = adaptRoll((args) => {
                const label = game.i18n.format('PF2E.SavingThrowWithName', {
                    saveName: game.i18n.localize(CONFIG.PF2E.saves[saveName]),
                });
                CheckPF2e.roll(
                    new CheckModifier(label, stat),
                    { actor: this, type: 'saving-throw', options: args.options, notes },
                    args.event,
                    args.callback,
                );
            });

            data.saves[saveName] = stat;
        }

        // Perception
        {
            const base: number = data.attributes.perception.base ?? Number(data.attributes.perception.value);
            const modifiers = [
                new ModifierPF2e('PF2E.BaseModifier', base - data.abilities.wis.mod, MODIFIER_TYPE.UNTYPED),
                new ModifierPF2e(CONFIG.PF2E.abilities.wis, data.abilities.wis.mod, MODIFIER_TYPE.ABILITY),
            ];
            const notes = [] as PF2RollNote[];
            ['perception', 'wis-based', 'all'].forEach((key) => {
                (statisticsModifiers[key] || []).map((m) => duplicate(m)).forEach((m) => modifiers.push(m));
                (rollNotes[key] ?? []).map((n) => duplicate(n)).forEach((n) => notes.push(n));
            });

            const stat = mergeObject(new StatisticModifier('perception', modifiers), data.attributes.perception, {
                overwrite: false,
            });
            stat.base = base;
            stat.value = stat.totalModifier;
            stat.breakdown = stat.modifiers
                .filter((m) => m.enabled)
                .map((m) => `${game.i18n.localize(m.name)} ${m.modifier < 0 ? '' : '+'}${m.modifier}`)
                .join(', ');
            stat.roll = adaptRoll((args) => {
                const label = game.i18n.localize('PF2E.PerceptionCheck');
                CheckPF2e.roll(
                    new CheckModifier(label, stat),
                    { actor: this, type: 'perception-check', options: args.options ?? [], notes },
                    args.event,
                    args.callback,
                );
            });

            data.attributes.perception = stat;
        }

        // default all skills to untrained
        data.skills = {};
        for (const [skill, { ability, shortform }] of Object.entries(SKILL_EXPANDED)) {
            const modifiers = [
                new ModifierPF2e('PF2E.BaseModifier', 0, MODIFIER_TYPE.UNTYPED),
                new ModifierPF2e(CONFIG.PF2E.abilities[ability], data.abilities[ability].mod, MODIFIER_TYPE.ABILITY),
            ];
            const notes = [] as PF2RollNote[];
            [skill, `${ability}-based`, 'skill-check', 'all'].forEach((key) => {
                (statisticsModifiers[key] || []).map((m) => duplicate(m)).forEach((m) => modifiers.push(m));
                (rollNotes[key] ?? []).map((n) => duplicate(n)).forEach((n) => notes.push(n));
            });

            const name = game.i18n.localize(`PF2E.Skill${SKILL_DICTIONARY[shortform].capitalize()}`);
            const stat = mergeObject(
                new StatisticModifier(name, modifiers),
                {
                    ability,
                    expanded: skill,
                    label: name,
                    visible: false,
                    roll: adaptRoll((args) => {
                        const label = game.i18n.format('PF2E.SkillCheckWithName', { skillName: name });
                        CheckPF2e.roll(
                            new CheckModifier(label, stat),
                            { actor: this, type: 'skill-check', options: args.options, notes },
                            args.event,
                            args.callback,
                        );
                    }),
                    lore: false,
                    rank: 0, // default to untrained
                },
                { overwrite: false },
            );
            stat.value = stat.totalModifier;
            stat.breakdown = stat.modifiers
                .filter((m) => m.enabled)
                .map((m) => `${game.i18n.localize(m.name)} ${m.modifier < 0 ? '' : '+'}${m.modifier}`)
                .join(', ');
            data.skills[shortform] = stat;
        }

        // Automatic Actions
        data.actions = [];

        // process OwnedItem instances, which for NPCs include skills, attacks, equipment, special abilities etc.
        for (const item of actorData.items.concat(strikes)) {
            if (item.type === 'lore') {
                // override untrained skills if defined in the NPC data
                const skill = item.name.slugify(); // normalize skill name to lower-case and dash-separated words
                // assume lore, if skill cannot be looked up
                const { ability, shortform } = SKILL_EXPANDED[skill] ?? { ability: 'int', shortform: skill };

                const base: number = (item.data.mod as any).base ?? Number(item.data.mod.value);
                const modifiers = [
                    new ModifierPF2e('PF2E.BaseModifier', base - data.abilities[ability].mod, MODIFIER_TYPE.UNTYPED),
                    new ModifierPF2e(
                        CONFIG.PF2E.abilities[ability],
                        data.abilities[ability].mod,
                        MODIFIER_TYPE.ABILITY,
                    ),
                ];
                const notes = [] as PF2RollNote[];
                [skill, `${ability}-based`, 'skill-check', 'all'].forEach((key) => {
                    (statisticsModifiers[key] || []).map((m) => duplicate(m)).forEach((m) => modifiers.push(m));
                    (rollNotes[key] ?? []).map((n) => duplicate(n)).forEach((n) => notes.push(n));
                });

                const stat = mergeObject(new StatisticModifier(item.name, modifiers), data.skills[shortform], {
                    overwrite: false,
                });
                stat.itemID = item._id;
                stat.base = base;
                stat.expanded = skill;
                stat.label = item.name;
                stat.lore = !SKILL_EXPANDED[skill];
                stat.rank = 1; // default to trained
                stat.value = stat.totalModifier;
                stat.visible = true;
                stat.breakdown = stat.modifiers
                    .filter((m) => m.enabled)
                    .map((m) => `${game.i18n.localize(m.name)} ${m.modifier < 0 ? '' : '+'}${m.modifier}`)
                    .join(', ');
                stat.roll = adaptRoll((args) => {
                    const label = game.i18n.format('PF2E.SkillCheckWithName', { skillName: item.name });
                    CheckPF2e.roll(
                        new CheckModifier(label, stat),
                        { actor: this, type: 'skill-check', options: args.options ?? [], dc: args.dc, notes },
                        args.event,
                        args.callback,
                    );
                });

                const variants = (item.data as any).variants;
                if (variants && Object.keys(variants).length) {
                    stat.variants = [];
                    for (const [, variant] of Object.entries(variants)) {
                        stat.variants.push(variant);
                    }
                }

                data.skills[shortform] = stat;
            } else if (item.type === 'melee') {
                const modifiers: ModifierPF2e[] = [];
                const notes = [] as PF2RollNote[];

                // traits
                const traits = item.data.traits.value;

                // Determine the base ability score for this attack.
                let ability: string;
                {
                    ability = item.data.weaponType?.value === 'ranged' ? 'dex' : 'str';
                    const bonus = Number(item.data?.bonus?.value ?? 0);
                    if (traits.includes('finesse')) {
                        ability = 'dex';
                    } else if (traits.includes('brutal')) {
                        ability = 'str';
                    }
                    modifiers.push(
                        new ModifierPF2e(
                            'PF2E.BaseModifier',
                            bonus - data.abilities[ability].mod,
                            MODIFIER_TYPE.UNTYPED,
                        ),
                        new ModifierPF2e(
                            CONFIG.PF2E.abilities[ability],
                            data.abilities[ability].mod,
                            MODIFIER_TYPE.ABILITY,
                        ),
                    );
                }

                // Conditions and Custom modifiers to attack rolls
                {
                    const stats: string[] = [];
                    stats.push(`${item.name.replace(/\s+/g, '-').toLowerCase()}-attack`); // convert white spaces to dash and lower-case all letters
                    stats
                        .concat([
                            'attack',
                            'mundane-attack',
                            `${ability}-attack`,
                            `${ability}-based`,
                            `${item._id}-attack`,
                            'attack-roll',
                            'all',
                        ])
                        .forEach((key) => {
                            (statisticsModifiers[key] || []).map((m) => duplicate(m)).forEach((m) => modifiers.push(m));
                            (rollNotes[key] ?? []).map((n) => duplicate(n)).forEach((n) => notes.push(n));
                        });
                }

                // action image
                const { imageUrl, actionGlyph } = ActorPF2e.getActionGraphics(
                    (item as any).data?.actionType?.value || 'action',
                    parseInt(((item as any).data?.actions || {}).value, 10) || 1,
                );

                const action = new StatisticModifier(item.name, modifiers) as NPCStrike;
                action.glyph = actionGlyph;
                action.imageUrl = imageUrl;
                action.sourceId = item._id;
                action.type = 'strike';
                action.description = item.data.description.value || '';
                action.attackRollType =
                    item.data.weaponType?.value === 'ranged' ? 'PF2E.NPCAttackRanged' : 'PF2E.NPCAttackMelee';
                action.breakdown = action.modifiers
                    .filter((m) => m.enabled)
                    .map((m) => `${game.i18n.localize(m.name)} ${m.modifier < 0 ? '' : '+'}${m.modifier}`)
                    .join(', ');

                action.traits = [
                    { name: 'attack', label: game.i18n.localize('PF2E.TraitAttack'), toggle: false },
                ].concat(
                    traits.map((trait) => {
                        const key = CONFIG.PF2E.weaponTraits[trait] ?? trait;
                        const option: CharacterStrikeTrait = {
                            name: trait,
                            label: key,
                            toggle: false,
                        };
                        return option;
                    }),
                );
                if (
                    action.attackRollType === 'PF2E.NPCAttackRanged' &&
                    !action.traits.some((trait) => trait.name === 'range')
                ) {
                    action.traits.splice(1, 0, {
                        name: 'range',
                        label: game.i18n.localize('PF2E.TraitRange'),
                        toggle: false,
                    });
                }
                // Add a damage roll breakdown
                action.damageBreakdown = Object.values(item.data.damageRolls).flatMap((roll) => {
                    return [
                        `${roll.damage} ${game.i18n.localize(
                            CONFIG.PF2E.damageTypes[roll.damageType as keyof ConfigPF2e['PF2E']['damageTypes']],
                        )}`,
                    ];
                });
                if (action.damageBreakdown.length > 0) {
                    if (this.isElite) {
                        action.damageBreakdown[0] =
                            action.damageBreakdown[0] + ` +2 ${game.i18n.localize('PF2E.NPC.Adjustment.EliteLabel')}`;
                    } else if (this.isWeak) {
                        action.damageBreakdown[0] =
                            action.damageBreakdown[0] + ` -2 ${game.i18n.localize('PF2E.NPC.Adjustment.WeakLabel')}`;
                    }
                }
                // Add attack effects to traits.
                const attackTraits = item.data.attackEffects.value.map((attackEffect: string) => {
                    return {
                        name: attackEffect.toLowerCase(),
                        label: attackEffect,
                        toggle: false,
                    };
                });
                action.traits.push(...attackTraits);
                // Add the base attack roll (used for determining on-hit)
                action.attack = adaptRoll(async (args) => {
                    const attackEffects = await this.getAttackEffects(item);
                    const rollNotes = notes.concat(attackEffects);
                    const options = (args.options ?? []).concat(item.data.traits.value); // always add all weapon traits as options
                    CheckPF2e.roll(
                        new CheckModifier(`Strike: ${action.name}`, action),
                        { actor: this, type: 'attack-roll', options, notes: rollNotes, dc: args.dc },
                        args.event,
                    );
                });
                action.roll = action.attack;

                const map = ItemPF2e.calculateMap(item);
                action.variants = [
                    {
                        label: `Strike ${action.totalModifier < 0 ? '' : '+'}${action.totalModifier}`,
                        roll: adaptRoll(async (args) => {
                            const attackEffects = await this.getAttackEffects(item);
                            const rollNotes = notes.concat(attackEffects);
                            const options = (args.options ?? []).concat(item.data.traits.value); // always add all weapon traits as options
                            options.push('constrict');
                            CheckPF2e.roll(
                                new CheckModifier(`Strike: ${action.name}`, action),
                                { actor: this, type: 'attack-roll', options, notes: rollNotes, dc: args.dc },
                                args.event,
                            );
                        }),
                    },
                    {
                        label: `MAP ${map.map2}`,
                        roll: adaptRoll(async (args) => {
                            const attackEffects = await this.getAttackEffects(item);
                            const rollNotes = notes.concat(attackEffects);
                            const options = (args.options ?? []).concat(item.data.traits.value); // always add all weapon traits as options
                            CheckPF2e.roll(
                                new CheckModifier(`Strike: ${action.name}`, action, [
                                    new ModifierPF2e('PF2E.MultipleAttackPenalty', map.map2, MODIFIER_TYPE.UNTYPED),
                                ]),
                                { actor: this, type: 'attack-roll', options, notes: rollNotes, dc: args.dc },
                                args.event,
                            );
                        }),
                    },
                    {
                        label: `MAP ${map.map3}`,
                        roll: adaptRoll(async (args) => {
                            const attackEffects = await this.getAttackEffects(item);
                            const rollNotes = notes.concat(attackEffects);
                            const options = (args.options ?? []).concat(item.data.traits.value); // always add all weapon traits as options
                            CheckPF2e.roll(
                                new CheckModifier(`Strike: ${action.name}`, action, [
                                    new ModifierPF2e('PF2E.MultipleAttackPenalty', map.map3, MODIFIER_TYPE.UNTYPED),
                                ]),
                                { actor: this, type: 'attack-roll', options, notes: rollNotes, dc: args.dc },
                                args.event,
                            );
                        }),
                    },
                ];
                action.damage = adaptRoll((args) => {
                    const options = (args.options ?? []).concat(item.data.traits.value); // always add all weapon traits as options
                    const damage = PF2WeaponDamage.calculateStrikeNPC(
                        item,
                        actorData,
                        action.traits,
                        statisticsModifiers,
                        damageDice,
                        1,
                        options,
                        rollNotes,
                    );
                    PF2DamageRoll.roll(
                        damage,
                        { type: 'damage-roll', outcome: 'success', options },
                        args.event,
                        args.callback,
                    );
                });
                action.critical = adaptRoll((args) => {
                    const options = (args.options ?? []).concat(item.data.traits.value); // always add all weapon traits as options
                    const damage = PF2WeaponDamage.calculateStrikeNPC(
                        item,
                        actorData,
                        action.traits,
                        statisticsModifiers,
                        damageDice,
                        1,
                        options,
                        rollNotes,
                    );
                    PF2DamageRoll.roll(
                        damage,
                        { type: 'damage-roll', outcome: 'criticalSuccess', options },
                        args.event,
                        args.callback,
                    );
                });

                data.actions.push(action);
            } else if (item.type === 'spellcastingEntry') {
                const tradition = item.data.tradition.value;
                const rank = item.data.proficiency.value;
                const ability = (item.data.ability.value || 'int') as AbilityString;
                const base = Number(item.data?.spelldc?.value ?? 0);
                const baseModifiers = [
                    new ModifierPF2e('PF2E.BaseModifier', base - data.abilities[ability].mod, MODIFIER_TYPE.UNTYPED),
                    new ModifierPF2e(
                        CONFIG.PF2E.abilities[ability],
                        data.abilities[ability].mod,
                        MODIFIER_TYPE.ABILITY,
                    ),
                ];
                const baseNotes = [] as PF2RollNote[];
                [`${ability}-based`, 'all'].forEach((key) => {
                    (statisticsModifiers[key] || []).map((m) => duplicate(m)).forEach((m) => baseModifiers.push(m));
                    (rollNotes[key] ?? []).map((n) => duplicate(n)).forEach((n) => baseNotes.push(n));
                });

                {
                    // add custom modifiers and roll notes relevant to the attack modifier for the spellcasting entry
                    const modifiers = [...baseModifiers];
                    const notes = [...baseNotes];
                    [`${tradition}-spell-attack`, 'spell-attack', 'attack', 'attack-roll'].forEach((key) => {
                        (statisticsModifiers[key] || []).map((m) => duplicate(m)).forEach((m) => modifiers.push(m));
                        (rollNotes[key] ?? []).map((n) => duplicate(n)).forEach((n) => notes.push(n));
                    });

                    const attack: StatisticModifier & Partial<SpellAttackRollModifier> = new StatisticModifier(
                        item.name,
                        modifiers,
                    );
                    attack.notes = notes;
                    attack.value = attack.totalModifier;
                    attack.breakdown = attack.modifiers
                        .filter((m) => m.enabled)
                        .map((m) => `${game.i18n.localize(m.name)} ${m.modifier < 0 ? '' : '+'}${m.modifier}`)
                        .join(', ');
                    attack.roll = adaptRoll((args) => {
                        const label = game.i18n.format(`PF2E.SpellAttack.${tradition}`);
                        const options = args.options ?? [];
                        ensureProficiencyOption(options, rank);
                        CheckPF2e.roll(
                            new CheckModifier(label, attack, args.modifiers ?? []),
                            { actor: this, type: 'spell-attack-roll', options, dc: args.dc, notes },
                            args.event,
                            args.callback,
                        );
                    });
                    item.data.attack = attack as Required<SpellAttackRollModifier>;
                }

                {
                    // add custom modifiers and roll notes relevant to the DC for the spellcasting entry
                    const base = Number(item.data?.spelldc?.dc ?? 0);
                    const modifiers = [
                        new ModifierPF2e(
                            'PF2E.BaseModifier',
                            base - 10 - data.abilities[ability].mod,
                            MODIFIER_TYPE.UNTYPED,
                        ),
                        new ModifierPF2e(
                            CONFIG.PF2E.abilities[ability],
                            data.abilities[ability].mod,
                            MODIFIER_TYPE.ABILITY,
                        ),
                    ];
                    const notes = [...baseNotes];
                    [`${tradition}-spell-dc`, 'spell-dc', `${ability}-based`, 'all'].forEach((key) => {
                        (statisticsModifiers[key] || []).map((m) => duplicate(m)).forEach((m) => modifiers.push(m));
                        (rollNotes[key] ?? []).map((n) => duplicate(n)).forEach((n) => notes.push(n));
                    });

                    const dc: StatisticModifier & Partial<SpellDifficultyClass> = new StatisticModifier(
                        item.name,
                        modifiers,
                    );
                    dc.notes = notes;
                    dc.value = 10 + dc.totalModifier;
                    dc.breakdown = [game.i18n.localize('PF2E.SpellDCBase')]
                        .concat(
                            dc.modifiers
                                .filter((m) => m.enabled)
                                .map((m) => `${game.i18n.localize(m.name)} ${m.modifier < 0 ? '' : '+'}${m.modifier}`),
                        )
                        .join(', ');
                    item.data.dc = dc as Required<SpellDifficultyClass>;
                }
            }
        }
    }

    private updateTokenAttitude(attitude: string) {
        const disposition = NPCPF2e.mapNPCAttitudeToTokenDisposition(attitude);
        const tokens = this._getTokenData();

        for (const key of Object.keys(tokens)) {
            const token = tokens[key];
            token.disposition = disposition;
        }

        const dispositionActorUpdate = {
            'token.disposition': disposition,
            attitude,
        };

        this._updateAllTokens(dispositionActorUpdate, tokens);
    }

    private static mapNPCAttitudeToTokenDisposition(attitude: string): number {
        if (attitude === null) {
            return CONST.TOKEN_DISPOSITIONS.HOSTILE;
        }

        if (attitude === 'hostile') {
            return CONST.TOKEN_DISPOSITIONS.HOSTILE;
        } else if (attitude === 'unfriendly' || attitude === 'indifferent') {
            return CONST.TOKEN_DISPOSITIONS.NEUTRAL;
        } else {
            return CONST.TOKEN_DISPOSITIONS.FRIENDLY;
        }
    }

    private static mapTokenDispositionToNPCAttitude(disposition: number): Attitude {
        if (disposition === CONST.TOKEN_DISPOSITIONS.FRIENDLY) {
            return 'friendly';
        } else if (disposition === CONST.TOKEN_DISPOSITIONS.NEUTRAL) {
            return 'indifferent';
        } else {
            return 'hostile';
        }
    }

    protected async getAttackEffects(item: MeleeData): Promise<PF2RollNote[]> {
        const notes: PF2RollNote[] = [];
        const description = item.data.description.value;
        if (description) {
            notes.push(
                new PF2RollNote(
                    'all',
                    `<div style="display: inline-block; font-weight: normal; line-height: 1.3em;" data-visibility="gm">${description}</div>`,
                ),
            );
        }
        for (const attackEffect of item.data.attackEffects.value) {
            const effectItem = this.data.items.find((item) => item.name.toLowerCase() === attackEffect.toLowerCase());
            const note = new PF2RollNote('all', '');
            if (effectItem) {
                // Get description from the actor item.
                const description = effectItem.data.description.value;
                note.text = `<div style="display: inline-block; font-weight: normal; line-height: 1.3em;" data-visibility="gm"><p><strong>${attackEffect}</strong></p>${description}</div>`;
                notes.push(note);
            } else {
                // Get description from the bestiary glossary compendium.
                const compendium = game.packs.get('pf2e.bestiary-ability-glossary-srd');
                if (compendium) {
                    const itemId =
                        (await compendium.getIndex())?.find((entry) => entry.name === attackEffect)?._id ?? '';
                    const packItem = (await compendium.getEntry(itemId)) as ActionData;
                    if (packItem) {
                        const description = packItem.data.description.value;
                        note.text = `<div style="display: inline-block; font-weight: normal; line-height: 1.3em;" data-visibility="gm"><strong>${attackEffect}</strong> ${description}</div>`;
                        notes.push(note);
                    } else {
                        console.warn(game.i18n.format('PF2E.NPC.AttackEffectMissing', { attackEffect }));
                    }
                }
            }
        }

        return notes;
    }

    protected getHpAdjustment(level: number): number {
        // Elite/Weak adjustment: Increase/decrease the creature's Hit Points based on its starting level (20+ 30HP, 5~19 20HP, 2~4 15HP, 1 or lower 10HP).
        if (level >= 20) {
            return 30;
        } else if (level <= 19 && level >= 5) {
            return 20;
        } else if (level <= 4 && level >= 2) {
            return 15;
        } else if (level <= 1) {
            return 10;
        }
        return 0;
    }

    protected _onUpdate(data: any, options: object, userId: string, context: object) {
        super._onUpdate(data, options, userId, context);

        const attitude = data?.data?.traits?.attitude?.value;

        if (attitude && game.userId === userId) {
            this.updateTokenAttitude(attitude);
        }
    }

    /** Make the NPC elite, weak, or normal */
    async applyAdjustment(adjustment: 'elite' | 'weak' | 'normal'): Promise<void> {
        if (
            (this.isElite && adjustment === 'elite') ||
            (this.isWeak && adjustment === 'weak') ||
            (!this.isElite && !this.isWeak && adjustment === 'normal')
        ) {
            return;
        }

        const extraHP = this.getHpAdjustment(this.level);
        const currentHP = this.data.data.attributes.hp.value;
        const newHP = (() => {
            switch (adjustment) {
                case 'elite':
                    return this.isWeak ? currentHP + extraHP * 2 : currentHP + extraHP;
                case 'weak':
                    return this.isElite ? currentHP - extraHP * 2 : currentHP - extraHP;
                default:
                    return this.isElite ? currentHP - extraHP : currentHP + extraHP;
            }
        })();

        const toAdd = adjustment === 'normal' ? [] : [adjustment];
        const toRemove = adjustment === 'weak' ? ['elite'] : adjustment === 'elite' ? ['weak'] : ['elite', 'weak'];
        const newTraits = this._data.data.traits.traits.value
            .filter((trait) => !toRemove.includes(trait))
            .concat(toAdd);

        await this.update({
            'data.attributes.hp.value': Math.max(0, newHP),
            'data.traits.traits.value': newTraits,
        });
    }

    updateNPCAttitudeFromDisposition(disposition: number) {
        this.data.data.traits.attitude.value = NPCPF2e.mapTokenDispositionToNPCAttitude(disposition);
    }
}

export interface NPCPF2e {
    data: NPCData;
    _data: NPCData;
}
