/**
 * Flickemon Game Data Configuration (Chrome Extension)
 * ─────────────────────────────────────────────────────
 * SINGLE SOURCE OF TRUTH for all game data.
 * Direct port of flickemon.config.ts → vanilla JS.
 */

// ─────────────────────────── Sprite Configuration ───────────────────────────

const SPRITE_BASE_URL = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon';

function getSpriteUrl(pokemonId) {
    return `${SPRITE_BASE_URL}/${pokemonId}.png`;
}

function getBackSpriteUrl(pokemonId) {
    return `${SPRITE_BASE_URL}/back/${pokemonId}.png`;
}

// ─────────────────────────── EXP & Leveling ───────────────────────────

const EXP_PER_MINUTE = 30;
const BATTLE_WIN_EXP_BONUS = 22;

function calculateRealMaxHp(baseHp, level) {
    return Math.floor(((2 * baseHp) * level) / 100) + level + 10;
}

function expForLevel(level) {
    return Math.pow(level, 3);
}

function levelFromExp(totalExp) {
    return Math.max(1, Math.floor(Math.cbrt(totalExp)));
}

const MAX_LEVEL = 100;

// ─────────────────────────── Evolution ───────────────────────────

const EVOLUTION_LEVELS = {
    stage1ToStage2: 16,
    stage2ToStage3: 36,
};

// ─────────────────────────── Encounter Weights ───────────────────────────

const ENCOUNTER_STAGE_WEIGHTS = [
    { stage: 1, weight: 0.88 },
    { stage: 2, weight: 0.11 },
    { stage: 3, weight: 0.01 },
];

// ─────────────────────────── Species Registry ───────────────────────────

const POKEMON_REGISTRY = [
    // ── GEN 1: KANTO (1 - 151) ──
    {id: 1, name: 'Bulbasaur', types: ['grass', 'poison'], baseStats: {hp: 45, attack: 49, defense: 49, speed: 45}, evolutionStage: 1, generation: 1},
    {id: 2, name: 'Ivysaur', types: ['grass', 'poison'], baseStats: {hp: 60, attack: 62, defense: 63, speed: 60}, evolutionStage: 2, generation: 1},
    {id: 3, name: 'Venusaur', types: ['grass', 'poison'], baseStats: {hp: 80, attack: 82, defense: 83, speed: 80}, evolutionStage: 3, generation: 1},
    {id: 4, name: 'Charmander', types: ['fire'], baseStats: {hp: 39, attack: 52, defense: 43, speed: 65}, evolutionStage: 1, generation: 1},
    {id: 5, name: 'Charmeleon', types: ['fire'], baseStats: {hp: 58, attack: 64, defense: 58, speed: 80}, evolutionStage: 2, generation: 1},
    {id: 6, name: 'Charizard', types: ['fire', 'flying'], baseStats: {hp: 78, attack: 84, defense: 78, speed: 100}, evolutionStage: 3, generation: 1},
    {id: 7, name: 'Squirtle', types: ['water'], baseStats: {hp: 44, attack: 48, defense: 65, speed: 43}, evolutionStage: 1, generation: 1},
    {id: 8, name: 'Wartortle', types: ['water'], baseStats: {hp: 59, attack: 63, defense: 80, speed: 58}, evolutionStage: 2, generation: 1},
    {id: 9, name: 'Blastoise', types: ['water'], baseStats: {hp: 79, attack: 83, defense: 100, speed: 78}, evolutionStage: 3, generation: 1},
    {id: 10, name: 'Caterpie', types: ['bug'], baseStats: {hp: 45, attack: 30, defense: 35, speed: 45}, evolutionStage: 1, generation: 1},
    {id: 11, name: 'Metapod', types: ['bug'], baseStats: {hp: 50, attack: 20, defense: 55, speed: 30}, evolutionStage: 2, generation: 1},
    {id: 12, name: 'Butterfree', types: ['bug', 'flying'], baseStats: {hp: 60, attack: 45, defense: 50, speed: 70}, evolutionStage: 3, generation: 1},
    {id: 13, name: 'Weedle', types: ['bug', 'poison'], baseStats: {hp: 40, attack: 35, defense: 30, speed: 50}, evolutionStage: 1, generation: 1},
    {id: 14, name: 'Kakuna', types: ['bug', 'poison'], baseStats: {hp: 45, attack: 25, defense: 50, speed: 35}, evolutionStage: 2, generation: 1},
    {id: 15, name: 'Beedrill', types: ['bug', 'poison'], baseStats: {hp: 65, attack: 90, defense: 40, speed: 75}, evolutionStage: 3, generation: 1},
    {id: 16, name: 'Pidgey', types: ['normal', 'flying'], baseStats: {hp: 40, attack: 45, defense: 40, speed: 56}, evolutionStage: 1, generation: 1},
    {id: 17, name: 'Pidgeotto', types: ['normal', 'flying'], baseStats: {hp: 63, attack: 60, defense: 55, speed: 71}, evolutionStage: 2, generation: 1},
    {id: 18, name: 'Pidgeot', types: ['normal', 'flying'], baseStats: {hp: 83, attack: 80, defense: 75, speed: 101}, evolutionStage: 3, generation: 1},
    {id: 19, name: 'Rattata', types: ['normal'], baseStats: {hp: 30, attack: 56, defense: 35, speed: 72}, evolutionStage: 1, generation: 1},
    {id: 20, name: 'Raticate', types: ['normal'], baseStats: {hp: 55, attack: 81, defense: 60, speed: 97}, evolutionStage: 2, generation: 1},
    {id: 21, name: 'Spearow', types: ['normal', 'flying'], baseStats: {hp: 40, attack: 60, defense: 30, speed: 70}, evolutionStage: 1, generation: 1},
    {id: 22, name: 'Fearow', types: ['normal', 'flying'], baseStats: {hp: 65, attack: 90, defense: 65, speed: 100}, evolutionStage: 2, generation: 1},
    {id: 23, name: 'Ekans', types: ['poison'], baseStats: {hp: 35, attack: 60, defense: 44, speed: 55}, evolutionStage: 1, generation: 1},
    {id: 24, name: 'Arbok', types: ['poison'], baseStats: {hp: 60, attack: 95, defense: 69, speed: 80}, evolutionStage: 2, generation: 1},
    {id: 25, name: 'Pikachu', types: ['electric'], baseStats: {hp: 35, attack: 55, defense: 40, speed: 90}, evolutionStage: 1, generation: 1},
    {id: 26, name: 'Raichu', types: ['electric'], baseStats: {hp: 60, attack: 90, defense: 55, speed: 110}, evolutionStage: 2, generation: 1},
    {id: 27, name: 'Sandshrew', types: ['ground'], baseStats: {hp: 50, attack: 75, defense: 85, speed: 40}, evolutionStage: 1, generation: 1},
    {id: 28, name: 'Sandslash', types: ['ground'], baseStats: {hp: 75, attack: 100, defense: 110, speed: 65}, evolutionStage: 2, generation: 1},
    {id: 29, name: 'Nidoran♀', types: ['poison'], baseStats: {hp: 55, attack: 47, defense: 52, speed: 41}, evolutionStage: 1, generation: 1},
    {id: 30, name: 'Nidorina', types: ['poison'], baseStats: {hp: 70, attack: 62, defense: 67, speed: 56}, evolutionStage: 2, generation: 1},
    {id: 31, name: 'Nidoqueen', types: ['poison', 'ground'], baseStats: {hp: 90, attack: 92, defense: 87, speed: 76}, evolutionStage: 3, generation: 1},
    {id: 32, name: 'Nidoran♂', types: ['poison'], baseStats: {hp: 46, attack: 57, defense: 40, speed: 50}, evolutionStage: 1, generation: 1},
    {id: 33, name: 'Nidorino', types: ['poison'], baseStats: {hp: 61, attack: 72, defense: 57, speed: 65}, evolutionStage: 2, generation: 1},
    {id: 34, name: 'Nidoking', types: ['poison', 'ground'], baseStats: {hp: 81, attack: 102, defense: 77, speed: 85}, evolutionStage: 3, generation: 1},
    {id: 35, name: 'Clefairy', types: ['fairy'], baseStats: {hp: 70, attack: 45, defense: 48, speed: 35}, evolutionStage: 1, generation: 1},
    {id: 36, name: 'Clefable', types: ['fairy'], baseStats: {hp: 95, attack: 70, defense: 73, speed: 60}, evolutionStage: 2, generation: 1},
    {id: 37, name: 'Vulpix', types: ['fire'], baseStats: {hp: 38, attack: 41, defense: 40, speed: 65}, evolutionStage: 1, generation: 1},
    {id: 38, name: 'Ninetales', types: ['fire'], baseStats: {hp: 73, attack: 76, defense: 75, speed: 100}, evolutionStage: 2, generation: 1},
    {id: 39, name: 'Jigglypuff', types: ['normal', 'fairy'], baseStats: {hp: 115, attack: 45, defense: 20, speed: 20}, evolutionStage: 1, generation: 1},
    {id: 40, name: 'Wigglytuff', types: ['normal', 'fairy'], baseStats: {hp: 140, attack: 70, defense: 45, speed: 45}, evolutionStage: 2, generation: 1},
    {id: 41, name: 'Zubat', types: ['poison', 'flying'], baseStats: {hp: 40, attack: 45, defense: 35, speed: 55}, evolutionStage: 1, generation: 1},
    {id: 42, name: 'Golbat', types: ['poison', 'flying'], baseStats: {hp: 75, attack: 80, defense: 70, speed: 90}, evolutionStage: 2, generation: 1},
    {id: 43, name: 'Oddish', types: ['grass', 'poison'], baseStats: {hp: 45, attack: 50, defense: 55, speed: 30}, evolutionStage: 1, generation: 1},
    {id: 44, name: 'Gloom', types: ['grass', 'poison'], baseStats: {hp: 60, attack: 65, defense: 70, speed: 40}, evolutionStage: 2, generation: 1},
    {id: 45, name: 'Vileplume', types: ['grass', 'poison'], baseStats: {hp: 75, attack: 80, defense: 85, speed: 50}, evolutionStage: 3, generation: 1},
    {id: 46, name: 'Paras', types: ['bug', 'grass'], baseStats: {hp: 35, attack: 70, defense: 55, speed: 25}, evolutionStage: 1, generation: 1},
    {id: 47, name: 'Parasect', types: ['bug', 'grass'], baseStats: {hp: 60, attack: 95, defense: 80, speed: 30}, evolutionStage: 2, generation: 1},
    {id: 48, name: 'Venonat', types: ['bug', 'poison'], baseStats: {hp: 60, attack: 55, defense: 50, speed: 45}, evolutionStage: 1, generation: 1},
    {id: 49, name: 'Venomoth', types: ['bug', 'poison'], baseStats: {hp: 70, attack: 65, defense: 60, speed: 90}, evolutionStage: 2, generation: 1},
    {id: 50, name: 'Diglett', types: ['ground'], baseStats: {hp: 10, attack: 55, defense: 25, speed: 95}, evolutionStage: 1, generation: 1},
    {id: 51, name: 'Dugtrio', types: ['ground'], baseStats: {hp: 35, attack: 100, defense: 50, speed: 120}, evolutionStage: 2, generation: 1},
    {id: 52, name: 'Meowth', types: ['normal'], baseStats: {hp: 40, attack: 45, defense: 35, speed: 90}, evolutionStage: 1, generation: 1},
    {id: 53, name: 'Persian', types: ['normal'], baseStats: {hp: 65, attack: 70, defense: 60, speed: 115}, evolutionStage: 2, generation: 1},
    {id: 54, name: 'Psyduck', types: ['water'], baseStats: {hp: 50, attack: 52, defense: 48, speed: 55}, evolutionStage: 1, generation: 1},
    {id: 55, name: 'Golduck', types: ['water'], baseStats: {hp: 80, attack: 82, defense: 78, speed: 85}, evolutionStage: 2, generation: 1},
    {id: 56, name: 'Mankey', types: ['fighting'], baseStats: {hp: 40, attack: 80, defense: 35, speed: 70}, evolutionStage: 1, generation: 1},
    {id: 57, name: 'Primeape', types: ['fighting'], baseStats: {hp: 65, attack: 105, defense: 60, speed: 95}, evolutionStage: 2, generation: 1},
    {id: 58, name: 'Growlithe', types: ['fire'], baseStats: {hp: 55, attack: 70, defense: 45, speed: 60}, evolutionStage: 1, generation: 1},
    {id: 59, name: 'Arcanine', types: ['fire'], baseStats: {hp: 90, attack: 110, defense: 80, speed: 95}, evolutionStage: 2, generation: 1},
    {id: 60, name: 'Poliwag', types: ['water'], baseStats: {hp: 40, attack: 50, defense: 40, speed: 90}, evolutionStage: 1, generation: 1},
    {id: 61, name: 'Poliwhirl', types: ['water'], baseStats: {hp: 65, attack: 65, defense: 65, speed: 90}, evolutionStage: 2, generation: 1},
    {id: 62, name: 'Poliwrath', types: ['water', 'fighting'], baseStats: {hp: 90, attack: 95, defense: 95, speed: 70}, evolutionStage: 3, generation: 1},
    {id: 63, name: 'Abra', types: ['psychic'], baseStats: {hp: 25, attack: 20, defense: 15, speed: 90}, evolutionStage: 1, generation: 1},
    {id: 64, name: 'Kadabra', types: ['psychic'], baseStats: {hp: 40, attack: 35, defense: 30, speed: 105}, evolutionStage: 2, generation: 1},
    {id: 65, name: 'Alakazam', types: ['psychic'], baseStats: {hp: 55, attack: 50, defense: 45, speed: 120}, evolutionStage: 3, generation: 1},
    {id: 66, name: 'Machop', types: ['fighting'], baseStats: {hp: 70, attack: 80, defense: 50, speed: 35}, evolutionStage: 1, generation: 1},
    {id: 67, name: 'Machoke', types: ['fighting'], baseStats: {hp: 80, attack: 100, defense: 70, speed: 45}, evolutionStage: 2, generation: 1},
    {id: 68, name: 'Machamp', types: ['fighting'], baseStats: {hp: 90, attack: 130, defense: 80, speed: 55}, evolutionStage: 3, generation: 1},
    {id: 69, name: 'Bellsprout', types: ['grass', 'poison'], baseStats: {hp: 50, attack: 75, defense: 35, speed: 40}, evolutionStage: 1, generation: 1},
    {id: 70, name: 'Weepinbell', types: ['grass', 'poison'], baseStats: {hp: 65, attack: 90, defense: 50, speed: 55}, evolutionStage: 2, generation: 1},
    {id: 71, name: 'Victreebel', types: ['grass', 'poison'], baseStats: {hp: 80, attack: 105, defense: 65, speed: 70}, evolutionStage: 3, generation: 1},
    {id: 72, name: 'Tentacool', types: ['water', 'poison'], baseStats: {hp: 40, attack: 40, defense: 35, speed: 70}, evolutionStage: 1, generation: 1},
    {id: 73, name: 'Tentacruel', types: ['water', 'poison'], baseStats: {hp: 80, attack: 70, defense: 65, speed: 100}, evolutionStage: 2, generation: 1},
    {id: 74, name: 'Geodude', types: ['rock', 'ground'], baseStats: {hp: 40, attack: 80, defense: 100, speed: 20}, evolutionStage: 1, generation: 1},
    {id: 75, name: 'Graveler', types: ['rock', 'ground'], baseStats: {hp: 55, attack: 95, defense: 115, speed: 35}, evolutionStage: 2, generation: 1},
    {id: 76, name: 'Golem', types: ['rock', 'ground'], baseStats: {hp: 80, attack: 120, defense: 130, speed: 45}, evolutionStage: 3, generation: 1},
    {id: 77, name: 'Ponyta', types: ['fire'], baseStats: {hp: 50, attack: 85, defense: 55, speed: 90}, evolutionStage: 1, generation: 1},
    {id: 78, name: 'Rapidash', types: ['fire'], baseStats: {hp: 65, attack: 100, defense: 70, speed: 105}, evolutionStage: 2, generation: 1},
    {id: 79, name: 'Slowpoke', types: ['water', 'psychic'], baseStats: {hp: 90, attack: 65, defense: 65, speed: 15}, evolutionStage: 1, generation: 1},
    {id: 80, name: 'Slowbro', types: ['water', 'psychic'], baseStats: {hp: 95, attack: 75, defense: 110, speed: 30}, evolutionStage: 2, generation: 1},
    {id: 81, name: 'Magnemite', types: ['electric', 'steel'], baseStats: {hp: 25, attack: 35, defense: 70, speed: 45}, evolutionStage: 1, generation: 1},
    {id: 82, name: 'Magneton', types: ['electric', 'steel'], baseStats: {hp: 50, attack: 60, defense: 95, speed: 70}, evolutionStage: 2, generation: 1},
    {id: 83, name: "Farfetch'd", types: ['normal', 'flying'], baseStats: {hp: 52, attack: 90, defense: 55, speed: 60}, evolutionStage: 1, generation: 1},
    {id: 84, name: 'Doduo', types: ['normal', 'flying'], baseStats: {hp: 35, attack: 85, defense: 45, speed: 75}, evolutionStage: 1, generation: 1},
    {id: 85, name: 'Dodrio', types: ['normal', 'flying'], baseStats: {hp: 60, attack: 110, defense: 70, speed: 110}, evolutionStage: 2, generation: 1},
    {id: 86, name: 'Seel', types: ['water'], baseStats: {hp: 65, attack: 45, defense: 55, speed: 45}, evolutionStage: 1, generation: 1},
    {id: 87, name: 'Dewgong', types: ['water', 'ice'], baseStats: {hp: 90, attack: 70, defense: 80, speed: 70}, evolutionStage: 2, generation: 1},
    {id: 88, name: 'Grimer', types: ['poison'], baseStats: {hp: 80, attack: 80, defense: 50, speed: 25}, evolutionStage: 1, generation: 1},
    {id: 89, name: 'Muk', types: ['poison'], baseStats: {hp: 105, attack: 105, defense: 75, speed: 50}, evolutionStage: 2, generation: 1},
    {id: 90, name: 'Shellder', types: ['water'], baseStats: {hp: 30, attack: 65, defense: 100, speed: 40}, evolutionStage: 1, generation: 1},
    {id: 91, name: 'Cloyster', types: ['water', 'ice'], baseStats: {hp: 50, attack: 95, defense: 180, speed: 70}, evolutionStage: 2, generation: 1},
    {id: 92, name: 'Gastly', types: ['ghost', 'poison'], baseStats: {hp: 30, attack: 35, defense: 30, speed: 80}, evolutionStage: 1, generation: 1},
    {id: 93, name: 'Haunter', types: ['ghost', 'poison'], baseStats: {hp: 45, attack: 50, defense: 45, speed: 95}, evolutionStage: 2, generation: 1},
    {id: 94, name: 'Gengar', types: ['ghost', 'poison'], baseStats: {hp: 60, attack: 65, defense: 60, speed: 110}, evolutionStage: 3, generation: 1},
    {id: 95, name: 'Onix', types: ['rock', 'ground'], baseStats: {hp: 35, attack: 45, defense: 160, speed: 70}, evolutionStage: 1, generation: 1},
    {id: 96, name: 'Drowzee', types: ['psychic'], baseStats: {hp: 60, attack: 48, defense: 45, speed: 42}, evolutionStage: 1, generation: 1},
    {id: 97, name: 'Hypno', types: ['psychic'], baseStats: {hp: 85, attack: 73, defense: 70, speed: 67}, evolutionStage: 2, generation: 1},
    {id: 98, name: 'Krabby', types: ['water'], baseStats: {hp: 30, attack: 105, defense: 90, speed: 50}, evolutionStage: 1, generation: 1},
    {id: 99, name: 'Kingler', types: ['water'], baseStats: {hp: 55, attack: 130, defense: 115, speed: 75}, evolutionStage: 2, generation: 1},
    {id: 100, name: 'Voltorb', types: ['electric'], baseStats: {hp: 40, attack: 30, defense: 50, speed: 100}, evolutionStage: 1, generation: 1},
    {id: 101, name: 'Electrode', types: ['electric'], baseStats: {hp: 60, attack: 50, defense: 70, speed: 150}, evolutionStage: 2, generation: 1},
    {id: 102, name: 'Exeggcute', types: ['grass', 'psychic'], baseStats: {hp: 60, attack: 40, defense: 80, speed: 40}, evolutionStage: 1, generation: 1},
    {id: 103, name: 'Exeggutor', types: ['grass', 'psychic'], baseStats: {hp: 95, attack: 95, defense: 85, speed: 55}, evolutionStage: 2, generation: 1},
    {id: 104, name: 'Cubone', types: ['ground'], baseStats: {hp: 50, attack: 50, defense: 95, speed: 35}, evolutionStage: 1, generation: 1},
    {id: 105, name: 'Marowak', types: ['ground'], baseStats: {hp: 60, attack: 80, defense: 110, speed: 45}, evolutionStage: 2, generation: 1},
    {id: 106, name: 'Hitmonlee', types: ['fighting'], baseStats: {hp: 50, attack: 120, defense: 53, speed: 87}, evolutionStage: 1, generation: 1},
    {id: 107, name: 'Hitmonchan', types: ['fighting'], baseStats: {hp: 50, attack: 105, defense: 79, speed: 76}, evolutionStage: 1, generation: 1},
    {id: 108, name: 'Lickitung', types: ['normal'], baseStats: {hp: 90, attack: 55, defense: 75, speed: 30}, evolutionStage: 1, generation: 1},
    {id: 109, name: 'Koffing', types: ['poison'], baseStats: {hp: 40, attack: 65, defense: 95, speed: 35}, evolutionStage: 1, generation: 1},
    {id: 110, name: 'Weezing', types: ['poison'], baseStats: {hp: 65, attack: 90, defense: 120, speed: 60}, evolutionStage: 2, generation: 1},
    {id: 111, name: 'Rhyhorn', types: ['ground', 'rock'], baseStats: {hp: 80, attack: 85, defense: 95, speed: 25}, evolutionStage: 1, generation: 1},
    {id: 112, name: 'Rhydon', types: ['ground', 'rock'], baseStats: {hp: 105, attack: 130, defense: 120, speed: 40}, evolutionStage: 2, generation: 1},
    {id: 113, name: 'Chansey', types: ['normal'], baseStats: {hp: 250, attack: 5, defense: 5, speed: 50}, evolutionStage: 1, generation: 1},
    {id: 114, name: 'Tangela', types: ['grass'], baseStats: {hp: 65, attack: 55, defense: 115, speed: 60}, evolutionStage: 1, generation: 1},
    {id: 115, name: 'Kangaskhan', types: ['normal'], baseStats: {hp: 105, attack: 95, defense: 80, speed: 90}, evolutionStage: 1, generation: 1},
    {id: 116, name: 'Horsea', types: ['water'], baseStats: {hp: 30, attack: 40, defense: 70, speed: 60}, evolutionStage: 1, generation: 1},
    {id: 117, name: 'Seadra', types: ['water'], baseStats: {hp: 55, attack: 65, defense: 95, speed: 85}, evolutionStage: 2, generation: 1},
    {id: 118, name: 'Goldeen', types: ['water'], baseStats: {hp: 45, attack: 67, defense: 60, speed: 63}, evolutionStage: 1, generation: 1},
    {id: 119, name: 'Seaking', types: ['water'], baseStats: {hp: 80, attack: 92, defense: 65, speed: 68}, evolutionStage: 2, generation: 1},
    {id: 120, name: 'Staryu', types: ['water'], baseStats: {hp: 30, attack: 45, defense: 55, speed: 85}, evolutionStage: 1, generation: 1},
    {id: 121, name: 'Starmie', types: ['water', 'psychic'], baseStats: {hp: 60, attack: 75, defense: 85, speed: 115}, evolutionStage: 2, generation: 1},
    {id: 122, name: 'Mr. Mime', types: ['psychic', 'fairy'], baseStats: {hp: 40, attack: 45, defense: 65, speed: 90}, evolutionStage: 1, generation: 1},
    {id: 123, name: 'Scyther', types: ['bug', 'flying'], baseStats: {hp: 70, attack: 110, defense: 80, speed: 105}, evolutionStage: 1, generation: 1},
    {id: 124, name: 'Jynx', types: ['ice', 'psychic'], baseStats: {hp: 65, attack: 50, defense: 35, speed: 95}, evolutionStage: 1, generation: 1},
    {id: 125, name: 'Electabuzz', types: ['electric'], baseStats: {hp: 65, attack: 83, defense: 57, speed: 105}, evolutionStage: 1, generation: 1},
    {id: 126, name: 'Magmar', types: ['fire'], baseStats: {hp: 65, attack: 95, defense: 57, speed: 93}, evolutionStage: 1, generation: 1},
    {id: 127, name: 'Pinsir', types: ['bug'], baseStats: {hp: 65, attack: 125, defense: 100, speed: 85}, evolutionStage: 1, generation: 1},
    {id: 128, name: 'Tauros', types: ['normal'], baseStats: {hp: 75, attack: 100, defense: 95, speed: 110}, evolutionStage: 1, generation: 1},
    {id: 129, name: 'Magikarp', types: ['water'], baseStats: {hp: 20, attack: 10, defense: 55, speed: 80}, evolutionStage: 1, generation: 1},
    {id: 130, name: 'Gyarados', types: ['water', 'flying'], baseStats: {hp: 95, attack: 125, defense: 79, speed: 81}, evolutionStage: 2, generation: 1},
    {id: 131, name: 'Lapras', types: ['water', 'ice'], baseStats: {hp: 130, attack: 85, defense: 80, speed: 60}, evolutionStage: 1, generation: 1},
    {id: 132, name: 'Ditto', types: ['normal'], baseStats: {hp: 48, attack: 48, defense: 48, speed: 48}, evolutionStage: 1, generation: 1},
    {id: 133, name: 'Eevee', types: ['normal'], baseStats: {hp: 55, attack: 55, defense: 50, speed: 55}, evolutionStage: 1, generation: 1},
    {id: 134, name: 'Vaporeon', types: ['water'], baseStats: {hp: 130, attack: 65, defense: 60, speed: 65}, evolutionStage: 2, generation: 1},
    {id: 135, name: 'Jolteon', types: ['electric'], baseStats: {hp: 65, attack: 65, defense: 60, speed: 130}, evolutionStage: 2, generation: 1},
    {id: 136, name: 'Flareon', types: ['fire'], baseStats: {hp: 65, attack: 130, defense: 60, speed: 65}, evolutionStage: 2, generation: 1},
    {id: 137, name: 'Porygon', types: ['normal'], baseStats: {hp: 65, attack: 60, defense: 70, speed: 40}, evolutionStage: 1, generation: 1},
    {id: 138, name: 'Omanyte', types: ['rock', 'water'], baseStats: {hp: 35, attack: 40, defense: 100, speed: 35}, evolutionStage: 1, generation: 1},
    {id: 139, name: 'Omastar', types: ['rock', 'water'], baseStats: {hp: 70, attack: 60, defense: 125, speed: 55}, evolutionStage: 2, generation: 1},
    {id: 140, name: 'Kabuto', types: ['rock', 'water'], baseStats: {hp: 30, attack: 80, defense: 90, speed: 55}, evolutionStage: 1, generation: 1},
    {id: 141, name: 'Kabutops', types: ['rock', 'water'], baseStats: {hp: 60, attack: 115, defense: 105, speed: 80}, evolutionStage: 2, generation: 1},
    {id: 142, name: 'Aerodactyl', types: ['rock', 'flying'], baseStats: {hp: 80, attack: 105, defense: 65, speed: 130}, evolutionStage: 1, generation: 1},
    {id: 143, name: 'Snorlax', types: ['normal'], baseStats: {hp: 160, attack: 110, defense: 65, speed: 30}, evolutionStage: 1, generation: 1},
    {id: 144, name: 'Articuno', types: ['ice', 'flying'], baseStats: {hp: 90, attack: 85, defense: 100, speed: 85}, evolutionStage: 1, generation: 1, isLegendary: true},
    {id: 145, name: 'Zapdos', types: ['electric', 'flying'], baseStats: {hp: 90, attack: 90, defense: 85, speed: 100}, evolutionStage: 1, generation: 1, isLegendary: true},
    {id: 146, name: 'Moltres', types: ['fire', 'flying'], baseStats: {hp: 90, attack: 100, defense: 90, speed: 90}, evolutionStage: 1, generation: 1, isLegendary: true},
    {id: 147, name: 'Dratini', types: ['dragon'], baseStats: {hp: 41, attack: 64, defense: 45, speed: 50}, evolutionStage: 1, generation: 1},
    {id: 148, name: 'Dragonair', types: ['dragon'], baseStats: {hp: 61, attack: 84, defense: 65, speed: 70}, evolutionStage: 2, generation: 1},
    {id: 149, name: 'Dragonite', types: ['dragon', 'flying'], baseStats: {hp: 91, attack: 134, defense: 95, speed: 80}, evolutionStage: 3, generation: 1},
    {id: 150, name: 'Mewtwo', types: ['psychic'], baseStats: {hp: 106, attack: 110, defense: 90, speed: 130}, evolutionStage: 1, generation: 1, isLegendary: true},
    {id: 151, name: 'Mew', types: ['psychic'], baseStats: {hp: 100, attack: 100, defense: 100, speed: 100}, evolutionStage: 1, generation: 1, isLegendary: true},

    // ── GEN 2 STARTERS & EVOLUTIONS ──
    {id: 152, name: 'Chikorita', types: ['grass'], baseStats: {hp: 45, attack: 49, defense: 65, speed: 45}, evolutionStage: 1, generation: 2},
    {id: 153, name: 'Bayleef', types: ['grass'], baseStats: {hp: 60, attack: 62, defense: 80, speed: 60}, evolutionStage: 2, generation: 2},
    {id: 154, name: 'Meganium', types: ['grass'], baseStats: {hp: 80, attack: 82, defense: 100, speed: 80}, evolutionStage: 3, generation: 2},
    {id: 155, name: 'Cyndaquil', types: ['fire'], baseStats: {hp: 39, attack: 52, defense: 43, speed: 65}, evolutionStage: 1, generation: 2},
    {id: 156, name: 'Quilava', types: ['fire'], baseStats: {hp: 58, attack: 64, defense: 58, speed: 80}, evolutionStage: 2, generation: 2},
    {id: 157, name: 'Typhlosion', types: ['fire'], baseStats: {hp: 78, attack: 84, defense: 78, speed: 100}, evolutionStage: 3, generation: 2},
    {id: 158, name: 'Totodile', types: ['water'], baseStats: {hp: 50, attack: 65, defense: 64, speed: 43}, evolutionStage: 1, generation: 2},
    {id: 159, name: 'Croconaw', types: ['water'], baseStats: {hp: 65, attack: 80, defense: 80, speed: 58}, evolutionStage: 2, generation: 2},
    {id: 160, name: 'Feraligatr', types: ['water'], baseStats: {hp: 85, attack: 105, defense: 100, speed: 78}, evolutionStage: 3, generation: 2},

    // ── GEN 3 STARTERS & EVOLUTIONS ──
    {id: 252, name: 'Treecko', types: ['grass'], baseStats: {hp: 40, attack: 45, defense: 35, speed: 70}, evolutionStage: 1, generation: 3},
    {id: 253, name: 'Grovyle', types: ['grass'], baseStats: {hp: 50, attack: 65, defense: 45, speed: 95}, evolutionStage: 2, generation: 3},
    {id: 254, name: 'Sceptile', types: ['grass'], baseStats: {hp: 70, attack: 85, defense: 65, speed: 120}, evolutionStage: 3, generation: 3},
    {id: 255, name: 'Torchic', types: ['fire'], baseStats: {hp: 45, attack: 60, defense: 40, speed: 45}, evolutionStage: 1, generation: 3},
    {id: 256, name: 'Combusken', types: ['fire', 'fighting'], baseStats: {hp: 60, attack: 85, defense: 60, speed: 55}, evolutionStage: 2, generation: 3},
    {id: 257, name: 'Blaziken', types: ['fire', 'fighting'], baseStats: {hp: 80, attack: 120, defense: 70, speed: 80}, evolutionStage: 3, generation: 3},
    {id: 258, name: 'Mudkip', types: ['water'], baseStats: {hp: 50, attack: 70, defense: 50, speed: 40}, evolutionStage: 1, generation: 3},
    {id: 259, name: 'Marshtomp', types: ['water', 'ground'], baseStats: {hp: 70, attack: 85, defense: 70, speed: 50}, evolutionStage: 2, generation: 3},
    {id: 260, name: 'Swampert', types: ['water', 'ground'], baseStats: {hp: 100, attack: 110, defense: 90, speed: 60}, evolutionStage: 3, generation: 3},

    // ── GEN 4 STARTERS & EVOLUTIONS ──
    {id: 387, name: 'Turtwig', types: ['grass'], baseStats: {hp: 55, attack: 68, defense: 64, speed: 31}, evolutionStage: 1, generation: 4},
    {id: 388, name: 'Grotle', types: ['grass'], baseStats: {hp: 75, attack: 89, defense: 85, speed: 36}, evolutionStage: 2, generation: 4},
    {id: 389, name: 'Torterra', types: ['grass', 'ground'], baseStats: {hp: 95, attack: 109, defense: 105, speed: 56}, evolutionStage: 3, generation: 4},
    {id: 390, name: 'Chimchar', types: ['fire'], baseStats: {hp: 44, attack: 58, defense: 44, speed: 61}, evolutionStage: 1, generation: 4},
    {id: 391, name: 'Monferno', types: ['fire', 'fighting'], baseStats: {hp: 64, attack: 78, defense: 52, speed: 81}, evolutionStage: 2, generation: 4},
    {id: 392, name: 'Infernape', types: ['fire', 'fighting'], baseStats: {hp: 76, attack: 104, defense: 71, speed: 108}, evolutionStage: 3, generation: 4},
    {id: 393, name: 'Piplup', types: ['water'], baseStats: {hp: 53, attack: 51, defense: 53, speed: 40}, evolutionStage: 1, generation: 4},
    {id: 394, name: 'Prinplup', types: ['water'], baseStats: {hp: 64, attack: 66, defense: 68, speed: 50}, evolutionStage: 2, generation: 4},
    {id: 395, name: 'Empoleon', types: ['water', 'steel'], baseStats: {hp: 84, attack: 86, defense: 88, speed: 60}, evolutionStage: 3, generation: 4},

    // ── GEN 5 STARTERS & EVOLUTIONS ──
    {id: 495, name: 'Snivy', types: ['grass'], baseStats: {hp: 45, attack: 45, defense: 55, speed: 63}, evolutionStage: 1, generation: 5},
    {id: 496, name: 'Servine', types: ['grass'], baseStats: {hp: 60, attack: 60, defense: 75, speed: 83}, evolutionStage: 2, generation: 5},
    {id: 497, name: 'Serperior', types: ['grass'], baseStats: {hp: 75, attack: 75, defense: 95, speed: 113}, evolutionStage: 3, generation: 5},
    {id: 498, name: 'Tepig', types: ['fire'], baseStats: {hp: 65, attack: 63, defense: 45, speed: 45}, evolutionStage: 1, generation: 5},
    {id: 499, name: 'Pignite', types: ['fire', 'fighting'], baseStats: {hp: 90, attack: 93, defense: 55, speed: 55}, evolutionStage: 2, generation: 5},
    {id: 500, name: 'Emboar', types: ['fire', 'fighting'], baseStats: {hp: 110, attack: 123, defense: 65, speed: 65}, evolutionStage: 3, generation: 5},
    {id: 501, name: 'Oshawott', types: ['water'], baseStats: {hp: 55, attack: 55, defense: 45, speed: 45}, evolutionStage: 1, generation: 5},
    {id: 502, name: 'Dewott', types: ['water'], baseStats: {hp: 75, attack: 75, defense: 60, speed: 60}, evolutionStage: 2, generation: 5},
    {id: 503, name: 'Samurott', types: ['water'], baseStats: {hp: 95, attack: 100, defense: 85, speed: 70}, evolutionStage: 3, generation: 5},

    // ── GEN 6 STARTERS & EVOLUTIONS (KALOS) ──
    {id: 650, name: 'Chespin', types: ['grass'], baseStats: {hp: 56, attack: 61, defense: 65, speed: 38}, evolutionStage: 1, generation: 6},
    {id: 651, name: 'Quilladin', types: ['grass'], baseStats: {hp: 61, attack: 78, defense: 95, speed: 57}, evolutionStage: 2, generation: 6},
    {id: 652, name: 'Chesnaught', types: ['grass', 'fighting'], baseStats: {hp: 88, attack: 107, defense: 122, speed: 64}, evolutionStage: 3, generation: 6},
    {id: 653, name: 'Fennekin', types: ['fire'], baseStats: {hp: 40, attack: 45, defense: 40, speed: 60}, evolutionStage: 1, generation: 6},
    {id: 654, name: 'Braixen', types: ['fire'], baseStats: {hp: 59, attack: 59, defense: 58, speed: 73}, evolutionStage: 2, generation: 6},
    {id: 655, name: 'Delphox', types: ['fire', 'psychic'], baseStats: {hp: 75, attack: 69, defense: 72, speed: 104}, evolutionStage: 3, generation: 6},
    {id: 656, name: 'Froakie', types: ['water'], baseStats: {hp: 41, attack: 56, defense: 40, speed: 71}, evolutionStage: 1, generation: 6},
    {id: 657, name: 'Frogadier', types: ['water'], baseStats: {hp: 54, attack: 63, defense: 52, speed: 97}, evolutionStage: 2, generation: 6},
    {id: 658, name: 'Greninja', types: ['water', 'dark'], baseStats: {hp: 72, attack: 95, defense: 67, speed: 122}, evolutionStage: 3, generation: 6},
    {id: 700, name: 'Sylveon', types: ['fairy'], baseStats: {hp: 95, attack: 65, defense: 65, speed: 60}, evolutionStage: 2, generation: 6},
    {id: 701, name: 'Hawlucha', types: ['fighting', 'flying'], baseStats: {hp: 78, attack: 92, defense: 75, speed: 118}, evolutionStage: 1, generation: 6},
    {id: 704, name: 'Goomy', types: ['dragon'], baseStats: {hp: 45, attack: 50, defense: 35, speed: 40}, evolutionStage: 1, generation: 6},
    {id: 705, name: 'Sliggoo', types: ['dragon'], baseStats: {hp: 68, attack: 75, defense: 53, speed: 60}, evolutionStage: 2, generation: 6},
    {id: 706, name: 'Goodra', types: ['dragon'], baseStats: {hp: 90, attack: 100, defense: 70, speed: 80}, evolutionStage: 3, generation: 6},

    // ── GEN 7 STARTERS & EVOLUTIONS (ALOLA) ──
    {id: 722, name: 'Rowlet', types: ['grass', 'flying'], baseStats: {hp: 68, attack: 55, defense: 55, speed: 42}, evolutionStage: 1, generation: 7},
    {id: 723, name: 'Dartrix', types: ['grass', 'flying'], baseStats: {hp: 78, attack: 70, defense: 75, speed: 52}, evolutionStage: 2, generation: 7},
    {id: 724, name: 'Decidueye', types: ['grass', 'ghost'], baseStats: {hp: 78, attack: 107, defense: 75, speed: 70}, evolutionStage: 3, generation: 7},
    {id: 725, name: 'Litten', types: ['fire'], baseStats: {hp: 45, attack: 65, defense: 40, speed: 70}, evolutionStage: 1, generation: 7},
    {id: 726, name: 'Torracat', types: ['fire'], baseStats: {hp: 65, attack: 85, defense: 50, speed: 90}, evolutionStage: 2, generation: 7},
    {id: 727, name: 'Incineroar', types: ['fire', 'dark'], baseStats: {hp: 95, attack: 115, defense: 90, speed: 60}, evolutionStage: 3, generation: 7},
    {id: 728, name: 'Popplio', types: ['water'], baseStats: {hp: 50, attack: 54, defense: 54, speed: 40}, evolutionStage: 1, generation: 7},
    {id: 729, name: 'Brionne', types: ['water'], baseStats: {hp: 60, attack: 69, defense: 69, speed: 50}, evolutionStage: 2, generation: 7},
    {id: 730, name: 'Primarina', types: ['water', 'fairy'], baseStats: {hp: 80, attack: 74, defense: 74, speed: 60}, evolutionStage: 3, generation: 7},
    {id: 744, name: 'Rockruff', types: ['rock'], baseStats: {hp: 45, attack: 65, defense: 40, speed: 60}, evolutionStage: 1, generation: 7},
    {id: 745, name: 'Lycanroc', types: ['rock'], baseStats: {hp: 75, attack: 115, defense: 65, speed: 112}, evolutionStage: 2, generation: 7},
    {id: 778, name: 'Mimikyu', types: ['ghost', 'fairy'], baseStats: {hp: 55, attack: 90, defense: 80, speed: 96}, evolutionStage: 1, generation: 7},
];

// ─────────────────────────── Evolution Chains ───────────────────────────

const EVOLUTION_CHAINS = [
    // Gen 1 Starters
    {fromId: 1, toId: 2, level: EVOLUTION_LEVELS.stage1ToStage2},
    {fromId: 2, toId: 3, level: EVOLUTION_LEVELS.stage2ToStage3},
    {fromId: 4, toId: 5, level: EVOLUTION_LEVELS.stage1ToStage2},
    {fromId: 5, toId: 6, level: EVOLUTION_LEVELS.stage2ToStage3},
    {fromId: 7, toId: 8, level: EVOLUTION_LEVELS.stage1ToStage2},
    {fromId: 8, toId: 9, level: EVOLUTION_LEVELS.stage2ToStage3},
    // Gen 1 Insects
    {fromId: 10, toId: 11, level: 7},
    {fromId: 11, toId: 12, level: 10},
    {fromId: 13, toId: 14, level: 7},
    {fromId: 14, toId: 15, level: 10},
    // Gen 1 Common
    {fromId: 16, toId: 17, level: EVOLUTION_LEVELS.stage1ToStage2},
    {fromId: 17, toId: 18, level: EVOLUTION_LEVELS.stage2ToStage3},
    {fromId: 19, toId: 20, level: 20},
    {fromId: 21, toId: 22, level: 20},
    {fromId: 23, toId: 24, level: 22},
    {fromId: 25, toId: 26, level: EVOLUTION_LEVELS.stage1ToStage2},
    {fromId: 27, toId: 28, level: 22},
    {fromId: 29, toId: 30, level: 16},
    {fromId: 30, toId: 31, level: 36},
    {fromId: 32, toId: 33, level: 16},
    {fromId: 33, toId: 34, level: 36},
    {fromId: 35, toId: 36, level: 20},
    {fromId: 37, toId: 38, level: 20},
    {fromId: 39, toId: 40, level: 20},
    {fromId: 41, toId: 42, level: 22},
    {fromId: 43, toId: 44, level: 16},
    {fromId: 44, toId: 45, level: 36},
    {fromId: 46, toId: 47, level: 24},
    {fromId: 48, toId: 49, level: 31},
    {fromId: 50, toId: 51, level: 26},
    {fromId: 52, toId: 53, level: 28},
    {fromId: 54, toId: 55, level: 33},
    {fromId: 56, toId: 57, level: 28},
    {fromId: 58, toId: 59, level: 20},
    {fromId: 60, toId: 61, level: 16},
    {fromId: 61, toId: 62, level: 36},
    {fromId: 63, toId: 64, level: 16},
    {fromId: 64, toId: 65, level: 36},
    {fromId: 66, toId: 67, level: 16},
    {fromId: 67, toId: 68, level: 36},
    {fromId: 69, toId: 70, level: 16},
    {fromId: 70, toId: 71, level: 36},
    {fromId: 72, toId: 73, level: 30},
    {fromId: 74, toId: 75, level: 16},
    {fromId: 75, toId: 76, level: 36},
    {fromId: 77, toId: 78, level: 40},
    {fromId: 79, toId: 80, level: 37},
    {fromId: 81, toId: 82, level: 30},
    {fromId: 84, toId: 85, level: 31},
    {fromId: 86, toId: 87, level: 34},
    {fromId: 88, toId: 89, level: 38},
    {fromId: 90, toId: 91, level: 20},
    {fromId: 92, toId: 93, level: 16},
    {fromId: 93, toId: 94, level: 36},
    {fromId: 96, toId: 97, level: 26},
    {fromId: 98, toId: 99, level: 28},
    {fromId: 100, toId: 101, level: 30},
    {fromId: 102, toId: 103, level: 20},
    {fromId: 104, toId: 105, level: 28},
    {fromId: 109, toId: 110, level: 35},
    {fromId: 111, toId: 112, level: 42},
    {fromId: 116, toId: 117, level: 32},
    {fromId: 118, toId: 119, level: 33},
    {fromId: 120, toId: 121, level: 20},
    {fromId: 129, toId: 130, level: 20},
    {fromId: 133, toId: 134, level: 20},
    {fromId: 138, toId: 139, level: 40},
    {fromId: 140, toId: 141, level: 40},
    {fromId: 147, toId: 148, level: 30},
    {fromId: 148, toId: 149, level: 55},

    // Gen 2 Starters
    {fromId: 152, toId: 153, level: 16},
    {fromId: 153, toId: 154, level: 36},
    {fromId: 155, toId: 156, level: 14},
    {fromId: 156, toId: 157, level: 36},
    {fromId: 158, toId: 159, level: 18},
    {fromId: 159, toId: 160, level: 30},

    // Gen 3 Starters
    {fromId: 252, toId: 253, level: 16},
    {fromId: 253, toId: 254, level: 36},
    {fromId: 255, toId: 256, level: 16},
    {fromId: 256, toId: 257, level: 36},
    {fromId: 258, toId: 259, level: 16},
    {fromId: 259, toId: 260, level: 36},

    // Gen 4 Starters
    {fromId: 387, toId: 388, level: 18},
    {fromId: 388, toId: 389, level: 32},
    {fromId: 390, toId: 391, level: 14},
    {fromId: 391, toId: 392, level: 36},
    {fromId: 393, toId: 394, level: 16},
    {fromId: 394, toId: 395, level: 36},

    // Gen 5 Starters
    {fromId: 495, toId: 496, level: 17},
    {fromId: 496, toId: 497, level: 36},
    {fromId: 498, toId: 499, level: 17},
    {fromId: 499, toId: 500, level: 36},
    {fromId: 501, toId: 502, level: 17},
    {fromId: 502, toId: 503, level: 36},

    // Gen 6 Starters & Dragon
    {fromId: 650, toId: 651, level: 16},
    {fromId: 651, toId: 652, level: 36},
    {fromId: 653, toId: 654, level: 16},
    {fromId: 654, toId: 655, level: 36},
    {fromId: 656, toId: 657, level: 16},
    {fromId: 657, toId: 658, level: 36},
    {fromId: 704, toId: 705, level: 40},
    {fromId: 705, toId: 706, level: 50},

    // Gen 7 Starters & Rockruff
    {fromId: 722, toId: 723, level: 17},
    {fromId: 723, toId: 724, level: 34},
    {fromId: 725, toId: 726, level: 17},
    {fromId: 726, toId: 727, level: 34},
    {fromId: 728, toId: 729, level: 17},
    {fromId: 729, toId: 730, level: 34},
    {fromId: 744, toId: 745, level: 25},
];

// ─────────────────────────── Starter Options ───────────────────────────

const STARTER_OPTIONS = [
    // Gen 1
    1, 4, 7, 25, 133,
    // Gen 2
    152, 155, 158,
    // Gen 3
    252, 255, 258,
    // Gen 4
    387, 390, 393,
    // Gen 5
    495, 498, 501,
    // Gen 6
    650, 653, 656,
    // Gen 7
    722, 725, 728,
];

// ─────────────────────────── Helper Utilities ───────────────────────────

function getSpeciesById(id) {
    return POKEMON_REGISTRY.find(p => p.id === id);
}

function getSpeciesByStage(stage) {
    return POKEMON_REGISTRY.filter(p => p.evolutionStage === stage);
}

function getEvolution(fromId) {
    return EVOLUTION_CHAINS.find(e => e.fromId === fromId);
}

function getAllEvolutions(fromId) {
    return EVOLUTION_CHAINS.filter(e => e.fromId === fromId);
}

function canEvolveAt(fromId, level) {
    const evolution = getEvolution(fromId);
    if (evolution && level >= evolution.level) {
        return evolution;
    }
    return null;
}

// Expose globally for other extension scripts
window.FlickemonConfig = {
    SPRITE_BASE_URL,
    getSpriteUrl,
    getBackSpriteUrl,
    EXP_PER_MINUTE,
    BATTLE_WIN_EXP_BONUS,
    calculateRealMaxHp,
    expForLevel,
    levelFromExp,
    MAX_LEVEL,
    EVOLUTION_LEVELS,
    ENCOUNTER_STAGE_WEIGHTS,
    POKEMON_REGISTRY,
    EVOLUTION_CHAINS,
    STARTER_OPTIONS,
    getSpeciesById,
    getSpeciesByStage,
    getEvolution,
    getAllEvolutions,
    canEvolveAt,
};
