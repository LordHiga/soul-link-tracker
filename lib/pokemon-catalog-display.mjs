const typeBadges = new Map([
    ['normal', ['Normal', 'bg-gray-700']], ['fighting', ['Kampf', 'bg-red-900']],
    ['flying', ['Flug', 'bg-indigo-600']], ['poison', ['Gift', 'bg-purple-700']],
    ['ground', ['Boden', 'bg-amber-800']], ['rock', ['Gestein', 'bg-stone-700']],
    ['bug', ['Käfer', 'bg-lime-800']], ['ghost', ['Geist', 'bg-violet-900']],
    ['steel', ['Stahl', 'bg-slate-600']], ['fire', ['Feuer', 'bg-orange-700']],
    ['water', ['Wasser', 'bg-blue-700']], ['grass', ['Pflanze', 'bg-green-700']],
    ['electric', ['Elektro', 'bg-yellow-700']], ['psychic', ['Psycho', 'bg-pink-700']],
    ['ice', ['Eis', 'bg-cyan-700']], ['dragon', ['Drache', 'bg-indigo-900']],
    ['dark', ['Unlicht', 'bg-zinc-900']]
]);

const cacheKey = 'soul-link-tracker:pokemon-catalog:v1';
const cacheDuration = 24 * 60 * 60 * 1000;
const normalizeName = name => name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

function indexCatalog(rows) {
    if (!Array.isArray(rows) || rows.length !== 386) throw new Error('Pokémon-Katalog unvollständig.');
    const byId = new Map();
    const byName = new Map();
    for (const row of rows) {
        const { id, name_de, type_primary, type_secondary } = row;
        if (!Number.isInteger(id) || id < 1 || id > 386 || byId.has(id) ||
            typeof name_de !== 'string' || !name_de.trim() || !typeBadges.has(type_primary) ||
            (type_secondary !== null && (!typeBadges.has(type_secondary) || type_primary === type_secondary))) {
            throw new Error('Pokémon-Katalog enthält ungültige Einträge.');
        }
        byId.set(id, row);
        const key = normalizeName(name_de);
        byName.set(key, byName.has(key) ? null : row);
    }
    return {
        byId,
        suggestions: [...new Set(rows.map(row => row.name_de))].sort((a, b) => a.localeCompare(b, 'de')),
        resolve: name => byName.get(normalizeName(name)) ?? null
    };
}

export async function loadPokemonCatalogData(selectRows, getStorage) {
    let storage;
    try {
        storage = getStorage();
        const cached = JSON.parse(storage?.getItem(cacheKey) ?? 'null');
        if (cached?.expiresAt > Date.now()) return indexCatalog(cached.rows);
    } catch {
        // Browser storage is optional, and invalid cache entries are replaced after a successful read.
    }
    const rows = await selectRows();
    const catalog = indexCatalog(rows);
    try {
        storage?.setItem(cacheKey, JSON.stringify({ expiresAt: Date.now() + cacheDuration, rows }));
    } catch {
        // Keep using the validated in-memory catalog.
    }
    return catalog;
}

export function getPokemonTypeBadges(entry) {
    if (!entry) return [];
    return [entry.type_primary, entry.type_secondary].map(type => typeBadges.get(type)).filter(Boolean);
}

export function getPokemonDisplayName(catchRecord, catalogById, reportMissing = console.warn) {
    const id = Number(catchRecord.pokemon_id);
    const belongsToCatalog = Number.isInteger(id) && id >= 1 && id <= 386;
    const name = belongsToCatalog ? catalogById?.get(id)?.name_de : null;
    if (name?.trim()) return name;

    reportMissing('Kein Pokémon-Katalogeintrag für gespeicherte ID', catchRecord.pokemon_id);
    return catchRecord.pokemon_name?.trim() ? catchRecord.pokemon_name : 'Unbekanntes Pokémon';
}
