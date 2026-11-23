const players = ['Higa', 'Eike', 'Ruffy'];
const slotNumbers = [1, 2, 3, 4, 5, 6];

export function createTeamController(request, render) {
    let runId;
    let revision = 0;
    let state = { data: null, loading: false, saving: false, error: '' };

    const update = changes => {
        state = { ...state, ...changes };
        render(state);
    };

    async function execute(action, fields = {}) {
        const write = action !== 'read';
        if (runId == null || state.saving || (!write && state.loading)) return;
        if (write && (!state.data || state.data.finished || state.error)) return;
        const ticket = ++revision;
        update({ loading: !write, saving: write, error: '' });
        try {
            const data = await request({ p_run_id: runId, p_action: action, ...fields });
            if (!data || !Array.isArray(data.slots) || !Array.isArray(data.candidates)) {
                throw new Error('Ungültiger Teamstand');
            }
            if (ticket === revision) update({ data, loading: false, saving: false });
        } catch {
            if (ticket === revision) update({
                loading: false, saving: false,
                error: write ? 'Die Teamänderung konnte nicht bestätigt werden. Lade das Team erneut.'
                    : 'Das Team konnte nicht geladen werden.'
            });
        }
    }

    return {
        async select(id) {
            if (id !== runId) {
                runId = id;
                revision++;
                update({ data: null, loading: false, saving: false, error: '' });
            }
            await execute('read');
        },
        refresh: () => execute('read'),
        change: (action, fields) => execute(action, fields),
        repaint: () => render(state)
    };
}

export function renderTeamGrid(slots, displayName, getBadges, escape) {
    const bySlot = new Map(slots.map(entry => [entry.slot, entry]));
    return slotNumbers.map(number => {
        const slot = bySlot.get(number);
        const cards = players.map(player => {
            const pokemon = slot?.pokemon.find(entry => entry.player_name === player);
            if (!pokemon) return `<div class="flex h-full items-center justify-center rounded bg-gray-100 text-xs text-gray-500"
                aria-label="Slot ${number}, leer">Slot ${number}</div>`;
            const id = Number(pokemon.pokemon_id);
            const sprite = Number.isSafeInteger(id) && id > 0 ? id : 0;
            const badges = getBadges(id).map(([label, color]) =>
                `<span class="rounded px-1 py-0.5 text-[10px] font-semibold leading-none text-white ${escape(color)}">${escape(label)}</span>`
            ).join('');
            return `<div class="grid h-full min-w-0 grid-cols-[1.25rem_minmax(0,1fr)] items-center gap-x-1 rounded bg-gray-50 px-1 py-0.5 lg:grid-cols-[1.5rem_minmax(0,1fr)_minmax(0,7rem)]">
                <img src="https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${sprite}.png"
                    alt="" loading="lazy" class="h-5 w-5 object-contain sm:h-6 sm:w-6">
                <span class="min-w-0 break-words text-[11px] font-semibold leading-tight text-gray-800 sm:text-xs">${escape(displayName(pokemon))}</span>
                <div class="col-span-2 flex flex-wrap gap-0.5 lg:col-span-1">${badges}</div>
            </div>`;
        }).join('');
        return `<div class="grid h-14 grid-cols-3 gap-1 sm:gap-2 lg:h-9" aria-label="Slot ${number}${slot ? ' · ' + escape(slot.route_name) : ''}">${cards}</div>`;
    }).join('');
}

export function mountSoulLinkTeam({ document, request, displayName, getBadges, escape }) {
    const grid = document.getElementById('team-grid');
    const notice = document.getElementById('team-notice');
    const manage = document.getElementById('team-manage');
    const retry = document.getElementById('team-retry');
    const dialog = document.getElementById('team-dialog');
    const controls = document.getElementById('team-controls');
    const dialogNotice = document.getElementById('team-dialog-notice');
    const dialogRetry = document.getElementById('team-dialog-retry');
    let current;

    function describe(route) {
        return route.route_name + ' · ' + players.map(player => {
            const pokemon = route.pokemon.find(entry => entry.player_name === player);
            return pokemon ? displayName(pokemon) : '–';
        }).join(' / ');
    }

    function renderDialog() {
        const { data, saving, error } = current;
        dialogNotice.textContent = error || (saving ? 'Speichert …' : '');
        dialogRetry.hidden = !error;
        if (!data || data.finished) {
            if (dialog.open) dialog.close();
            controls.innerHTML = '';
            return;
        }
        const candidateValue = document.getElementById('team-candidate')?.value;
        const slotValue = document.getElementById('team-replacement-slot')?.value;
        const unavailable = saving || Boolean(error);
        if (!data.initialized) {
            controls.innerHTML = `<p class="mb-2 text-sm">Übernimmt einmalig bis zu sechs vollständige ALIVE-Soul-Links dieses Runs.</p>
                <button type="button" class="rounded border px-2 py-1 text-sm font-semibold disabled:opacity-40"
                    data-team-action="initialize" ${unavailable ? 'disabled' : ''}>Team initialisieren</button>`;
            return;
        }
        const full = data.slots.length === 6;
        controls.innerHTML = `<div class="space-y-3">
            ${data.slots.map(slot => `<div class="flex items-center justify-between gap-2 border-b pb-1 text-sm">
                <span>Slot ${Number(slot.slot)} · ${escape(slot.route_name)}</span>
                <button type="button" class="px-1 py-1 text-xs font-semibold text-red-800 disabled:opacity-40" data-team-action="remove" data-slot="${Number(slot.slot)}"
                    ${unavailable ? 'disabled' : ''}>Entfernen</button></div>`).join('')}
            ${data.candidates.length ? `<div class="space-y-2">
                <label class="block text-sm" for="team-candidate">Verfügbare Soul Links</label>
                <select id="team-candidate" class="w-full rounded border p-2 text-sm">
                    ${data.candidates.map(route => `<option value="${escape(route.route_name)}">${escape(describe(route))}</option>`).join('')}
                </select>
                ${full ? `<label class="block text-sm" for="team-replacement-slot">Slot ersetzen</label>
                    <select id="team-replacement-slot" class="w-full rounded border p-2 text-sm">
                        ${data.slots.map(slot => `<option value="${escape(slot.route_name)}">Slot ${Number(slot.slot)} · ${escape(slot.route_name)}</option>`).join('')}
                    </select>` : ''}
                <button type="button" class="rounded border px-2 py-1 text-sm font-semibold disabled:opacity-40"
                    data-team-action="${full ? 'replace' : 'add'}" ${unavailable ? 'disabled' : ''}>
                    ${full ? 'Route austauschen' : 'Route aufnehmen'}
                </button></div>` : '<p class="text-sm text-gray-600">Keine weiteren vollständigen ALIVE-Soul-Links.</p>'}
            </div>`;
        if (data.candidates.some(route => route.route_name === candidateValue)) {
            document.getElementById('team-candidate').value = candidateValue;
        }
        if (full && data.slots.some(slot => slot.route_name === slotValue)) {
            document.getElementById('team-replacement-slot').value = slotValue;
        }
    }

    const controller = createTeamController(request, state => {
        current = state;
        const { data, loading, saving, error } = state;
        grid.innerHTML = renderTeamGrid(data?.slots ?? [], displayName, getBadges, escape);
        notice.textContent = error || (!data && loading ? 'Team wird geladen …' :
            data?.finished && !data.initialized ? 'Für diesen abgeschlossenen Run wurde kein Team gespeichert.' :
            data && !data.initialized ? 'Dieses Team kann einmalig initialisiert werden.' : '');
        retry.hidden = !error;
        manage.disabled = !data || data.finished || saving || Boolean(error);
        if (!data && dialog.open) dialog.close();
        if (dialog.open) renderDialog();
    });
    controller.repaint();

    manage.addEventListener('click', () => {
        if (manage.disabled) return;
        dialog.showModal();
        renderDialog();
    });
    retry.addEventListener('click', controller.refresh);
    document.getElementById('team-close').addEventListener('click', () => dialog.close());
    dialogRetry.addEventListener('click', controller.refresh);
    controls.addEventListener('click', event => {
        const button = event.target.closest('button[data-team-action]');
        if (!button || button.disabled || !current.data || current.data.finished) return;
        const action = button.dataset.teamAction;
        const route = document.getElementById('team-candidate')?.value;
        const slot = current.data.slots.find(entry => action === 'replace'
            ? entry.route_name === document.getElementById('team-replacement-slot')?.value
            : entry.slot === Number(button.dataset.slot));
        if (action === 'initialize') controller.change(action);
        if (action === 'add' && route) controller.change(action, { p_route: route });
        if (slot && (action === 'remove' || (action === 'replace' && route))) controller.change(action, {
            p_route: action === 'replace' ? route : null, p_slot: slot.slot, p_expected_route: slot.route_name
        });
    });
    return controller;
}
