(() => {
    'use strict';

    const $ = id => document.getElementById(id);

    const text = (id, v) => {
        $(id).textContent = v ?? '—';
    };

    const show = (id, v = true) => {
        $(id).hidden = !v;
    };

    const label = v => String(v ?? '—')
        .replace(/[_.]/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());

    const date = v => {
        if (!v) return '—';

        const d = new Date(
            String(v).replace(' ', 'T') +
            (/^\d{4}-\d\d-\d\dT?\s?\d\d:\d\d:\d\d$/.test(v) ? 'Z' : '')
        );

        return isNaN(d) ? v : d.toLocaleString();
    };

    const node = (tag, cls, value) => {
        const n = document.createElement(tag);

        if (cls) n.className = cls;
        if (value != null) n.textContent = value;

        return n;
    };

    const button = (title, fn) => {
        const n = node('button', 'button button-text', title);

        n.type = 'button';
        n.addEventListener('click', () => run(fn));

        return n;
    };

    const state = {
        view: 'overview',
        id: null,
        application: null,
        notes: [],
        notePage: 1,
        pages: {
            applications: 1,
            interviews: 1,
            activity: 1
        },
        settings: null,
        epoch: 0,
        busy: false
    };

    const transitions = {
        pending: [
            'under_review',
            'shortlisted',
            'declined',
            'withdrawn'
        ],

        under_review: [
            'pending',
            'shortlisted',
            'interview',
            'accepted',
            'declined',
            'withdrawn'
        ],

        shortlisted: [
            'under_review',
            'interview',
            'accepted',
            'declined',
            'withdrawn'
        ],

        interview: [
            'under_review',
            'shortlisted',
            'accepted',
            'declined',
            'withdrawn'
        ],

        accepted: ['under_review'],
        declined: ['under_review'],
        withdrawn: ['under_review']
    };

    async function api(
        path,
        method = 'GET',
        body,
        params = {}
    ) {
        const url = new URL(
            '/api/admin/' + path,
            location.origin
        );

        Object.entries(params).forEach(([k, v]) => {
            if (v !== '' && v != null && v !== 'all') {
                url.searchParams.set(k, v);
            }
        });

        const r = await fetch(url, {
            method,
            credentials: 'same-origin',
            cache: 'no-store',
            redirect: 'error',

            headers: {
                Accept: 'application/json',

                ...(body ? {
                    'Content-Type': 'application/json'
                } : {})
            },

            ...(body ? {
                body: JSON.stringify(body)
            } : {})
        });

        if (r.status === 401 || r.status === 403) {
            show('adminApp', false);
            show('loadingScreen', false);
            show('fatalErrorScreen');

            text(
                'fatalErrorMessage',
                'Your session is no longer authorized. Retry connection or sign in again.'
            );
        }

        const d = await r.json().catch(() => null);

        if (!r.ok || !d || d.success === false) {
            throw Error(
                d?.message ||
                d?.error?.message ||
                (
                    typeof d?.error === 'string'
                        ? d.error
                        : null
                ) ||
                `Request failed (${r.status}).`
            );
        }

        return d;
    }

    function toast(message) {
        const n = node('div', 'toast toast-success');

        n.append(
            node('div', 'toast-message', message)
        );

        $('toastContainer').append(n);

        setTimeout(() => n.remove(), 4500);
    }

    async function run(fn) {
        if (state.busy) return;

        state.busy = true;

        show('globalError', false);

        try {
            await fn();
        } catch (e) {
            text('globalErrorMessage', e.message);
            show('globalError');

            const dialog = document.querySelector(
                'dialog[open]'
            );

            if (dialog) {
                const old = dialog.querySelector(
                    '.request-error'
                );

                old?.remove();

                dialog.querySelector('.modal-body')?.append(
                    node(
                        'p',
                        'alert alert-error request-error',
                        e.message
                    )
                );
            }
        } finally {
            state.busy = false;
        }
    }

    function badge(el, status, title) {
        el.className = 'status-pill status-' + status;
        el.textContent = title || label(status);
    }

    function recruitment(r) {
        if (!r) return;

        badge(
            $('topbarRecruitmentStatus'),
            r.open ? 'open' : 'closed',
            'Recruitment ' + (r.open ? 'open' : 'closed')
        );

        const span = node(
            'span',
            '',
            'Recruitment ' + (r.open ? 'open' : 'closed')
        );

        span.id = 'topbarRecruitmentText';

        $('topbarRecruitmentStatus').replaceChildren(
            node('span', 'status-dot'),
            span
        );
    }

    function rows(id, items, cols, render) {
        const t = $(id);

        t.replaceChildren();

        if (!items.length) {
            const tr = node('tr');

            const td = node(
                'td',
                '',
                'No records found.'
            );

            td.colSpan = cols;

            tr.append(td);
            t.append(tr);

            return;
        }

        for (const a of items) {
            const tr = node('tr');

            for (const value of render(a)) {
                const td = node('td');

                td.append(
                    value instanceof Node
                        ? value
                        : document.createTextNode(
                            String(value ?? '—')
                        )
                );

                tr.append(td);
            }

            t.append(tr);
        }
    }

    function statusNode(s) {
        const n = node('span');

        badge(n, s);

        return n;
    }

    function identity(a) {
        const n = node('div', 'table-applicant');

        const d = node(
            'div',
            'table-applicant-details'
        );

        d.append(
            node(
                'strong',
                'table-primary',
                a.displayName
            ),

            node(
                'small',
                'table-secondary',
                a.robloxUsername
            )
        );

        n.append(
            node(
                'div',
                'table-avatar',
                (a.displayName || '?')[0].toUpperCase()
            ),

            d
        );

        return n;
    }

    function distribution(id, items) {
        $(id).replaceChildren();

        for (const a of items || []) {
            const n = node(
                'div',
                'distribution-row'
            );

            const h = node(
                'div',
                'distribution-header'
            );

            const track = node(
                'div',
                'distribution-track'
            );

            const fill = node(
                'div',
                'distribution-fill'
            );

            h.append(
                node(
                    'span',
                    '',
                    a.name || label(a.status)
                ),

                node(
                    'span',
                    'distribution-value',
                    `${a.total} (${a.percentage}%)`
                )
            );

            fill.style.width =
                Math.max(
                    0,
                    Math.min(
                        100,
                        Number(a.percentage) || 0
                    )
                ) + '%';

            track.append(fill);
            n.append(h, track);

            $(id).append(n);
        }
    }

    function chart(items) {
        const root = $('applicationChart');

        root.replaceChildren();

        if (!items?.length) {
            root.textContent = 'No activity available.';
            return;
        }

        const ns = 'http://www.w3.org/2000/svg';

        const svg = document.createElementNS(
            ns,
            'svg'
        );

        svg.setAttribute(
            'viewBox',
            '0 0 640 240'
        );

        svg.classList.add('chart-svg');

        const add = (tag, attrs, value) => {
            const n = document.createElementNS(
                ns,
                tag
            );

            for (const [k, v] of Object.entries(attrs)) {
                n.setAttribute(k, v);
            }

            if (value != null) {
                n.textContent = value;
            }

            svg.append(n);
        };

        const max = Math.max(
            1,
            ...items.map(
                a => Number(a.applications) || 0
            )
        );

        for (let i = 0; i <= 4; i++) {
            const y = 20 + i * 45;

            add('line', {
                x1: 40,
                x2: 620,
                y1: y,
                y2: y,
                class: 'chart-grid-line'
            });

            add(
                'text',
                {
                    x: 4,
                    y: y + 4,
                    class: 'chart-label'
                },
                Math.round(max * (1 - i / 4))
            );
        }

        const pts = items.map((a, i) => [
            40 + i * 580 / Math.max(
                1,
                items.length - 1
            ),

            200 - 180 *
                (Number(a.applications) || 0) / max
        ]);

        add('polyline', {
            points: pts.map(
                p => p.join(',')
            ).join(' '),

            class: 'chart-line'
        });

        pts.forEach(([x, y], i) => {
            add('circle', {
                cx: x,
                cy: y,
                r: 3,
                class: 'chart-point'
            });

            if (i % 3 === 0 || i === pts.length - 1) {
                add(
                    'text',
                    {
                        x,
                        y: 225,
                        'text-anchor': 'middle',
                        class: 'chart-label'
                    },
                    String(items[i].date).slice(5)
                );
            }
        });

        root.append(svg);
    }

    async function overview() {
        const d = await api('overview');

        const s = d.statistics || {};

        for (const [id, key] of Object.entries({
            statTotal: 'total',
            statPending: 'pending',
            statActive: 'active',
            statAccepted: 'accepted',
            statLast24Hours: 'last24Hours',
            statLast7Days: 'last7Days',
            statLast30Days: 'last30Days',
            statCompleted: 'completed',
            statInterview: 'interview'
        })) {
            text(id, s[key] ?? 0);
        }

        text(
            'statAcceptanceRate',
            (s.acceptanceRate ?? 0) + '%'
        );

        text(
            'statCompletionRate',
            (s.completionRate ?? 0) + '%'
        );

        text(
            'sidebarPendingCount',
            s.pending ?? 0
        );

        show(
            'sidebarPendingCount',
            s.pending > 0
        );

        text(
            'overviewUpdatedAt',
            date(d.generatedAt)
        );

        distribution(
            'statusDistribution',
            d.statusDistribution
        );

        distribution(
            'disciplineDistribution',
            d.disciplines
        );

        chart(d.trends);

        rows(
            'recentApplicationsBody',
            d.recentApplications || [],
            5,

            a => [
                identity(a),
                a.discipline,
                statusNode(a.status),
                date(a.createdAt),

                button(
                    'View',
                    () => navigate(
                        'application',
                        a.applicationId
                    )
                )
            ]
        );

        const r = d.recruitment;

        recruitment(r);

        badge(
            $('overviewRecruitmentBadge'),
            r.open ? 'open' : 'closed'
        );

        text(
            'overviewRecruitmentTitle',
            r.title
        );

        text(
            'overviewRecruitmentMessage',
            r.message
        );

        for (const [id, k] of Object.entries({
            healthDatabase: 'database',
            healthAuthentication: 'authentication',
            healthTurnstile: 'turnstile',
            healthConfiguration: 'recruitmentConfiguration'
        })) {
            text(
                id,
                typeof d.system?.[k] === 'object'
                    ? JSON.stringify(d.system[k])
                    : d.system?.[k]
            );
        }
    }

    function options(id, values) {
        const el = $(id);

        const old = el.value;

        const first =
            el.options[0]?.textContent || 'All';

        el.replaceChildren(
            new Option(first, 'all')
        );

        for (const v of values || []) {
            const value =
                typeof v === 'object'
                    ? (
                        v.value ??
                        v.name ??
                        v.actor ??
                        v.action ??
                        v.targetType
                    )
                    : v;

            if (value != null) {
                el.add(
                    new Option(
                        typeof v === 'object'
                            ? (v.label ?? value)
                            : value,

                        value
                    )
                );
            }
        }

        if ([...el.options].some(
            o => o.value === old
        )) {
            el.value = old;
        }
    }

    function pagination(prefix, p) {
        const page = Number(
            p.page ?? state.pages[prefix]
        );

        const total = Number(
            p.total ??
            p.totalItems ??
            p.totalRecords ??
            0
        );

        const pages = Number(
            p.totalPages ??
            Math.ceil(total / 25)
        );

        text(
            prefix + 'PaginationInfo',
            `${total} records`
        );

        text(
            prefix + 'PageNumber',
            `${page} / ${Math.max(1, pages)}`
        );

        $(prefix + 'PreviousPage').disabled =
            page <= 1;

        $(prefix + 'NextPage').disabled =
            page >= pages;
    }

    async function applications(interview = false) {
        const prefix =
            interview ? 'interviews' : 'applications';

        const d = await api(
            'applications',
            'GET',
            null,

            {
                page: state.pages[prefix],
                limit: 25,

                ...(interview
                    ? {
                        status: 'interview'
                    }
                    : {
                        search: $('applicationSearch').value,
                        status: $('applicationStatusFilter').value,
                        discipline: $('applicationDisciplineFilter').value,
                        sort: $('applicationSort').value
                    }
                )
            }
        );

        const p = d.pagination || {};

        pagination(prefix, p);

        if (interview) {
            text(
                'interviewCount',
                p.total ??
                p.totalItems ??
                d.applications.length
            );
        } else {
            options(
                'applicationDisciplineFilter',
                d.availableFilters?.disciplines
            );

            text(
                'applicationsResultCount',
                `${p.total ?? p.totalItems ?? d.applications.length} applications`
            );
        }

        rows(
            prefix + 'TableBody',
            d.applications || [],
            interview ? 5 : 6,

            a => interview
                ? [
                    identity(a),
                    a.discipline,
                    a.reviewer,
                    date(a.updatedAt),

                    button(
                        'View',
                        () => navigate(
                            'application',
                            a.applicationId
                        )
                    )
                ]
                : [
                    identity(a),
                    a.discipline,
                    statusNode(a.status),
                    date(a.createdAt),
                    a.reviewer,

                    button(
                        'View',
                        () => navigate(
                            'application',
                            a.applicationId
                        )
                    )
                ]
        );
    }

    async function profile() {
        const d = await api(
            'application',
            'GET',
            null,
            { id: state.id }
        );

        const a = state.application = d.application;

        for (const [id, k] of Object.entries({
            applicantReference: 'applicationId',
            applicantName: 'displayName',
            applicantSubtitle: 'robloxUsername',
            applicantRoblox: 'robloxUsername',
            applicantDiscord: 'discordUsername',
            applicantDiscipline: 'discipline',
            applicantExperience: 'experience',
            applicantReviewer: 'reviewer',
            applicantPrivacyVersion: 'privacyVersion',
            applicantPortfolioText: 'portfolioUrl',
            applicantIntroduction: 'introduction'
        })) {
            text(id, a[k]);
        }

        text(
            'applicantAvatar',
            (a.displayName || '?')[0].toUpperCase()
        );

        text(
            'applicantCreatedAt',
            date(a.createdAt)
        );

        text(
            'applicantUpdatedAt',
            date(a.updatedAt)
        );

        badge(
            $('applicantStatusBadge'),
            a.status
        );

        const link = $('applicantPortfolioLink');

        link.removeAttribute('href');

        try {
            const u = new URL(a.portfolioUrl);

            if (['https:', 'http:'].includes(u.protocol)) {
                link.href = u.href;
            }
        } catch {}

        link.rel = 'noopener noreferrer';
        link.target = '_blank';

        const pipe = $('applicantPipeline');

        pipe.replaceChildren();

        for (const s of Object.keys(transitions)) {
            const n = node(
                'div',
                'pipeline-step' +
                (s === a.status ? ' current' : '')
            );

            n.append(
                node(
                    'span',
                    'pipeline-dot',
                    s === a.status ? '●' : '○'
                ),

                node(
                    'span',
                    '',
                    label(s)
                )
            );

            pipe.append(n);
        }

        const h = $('applicantHistory');

        h.replaceChildren();

        for (const e of d.history || []) {
            const n = node(
                'div',
                'history-item'
            );

            const c = node(
                'div',
                'history-content'
            );

            c.append(
                node(
                    'div',
                    'history-title',

                    `${
                        e.previousStatus
                            ? label(e.previousStatus) + ' → '
                            : ''
                    }${label(e.newStatus)}`
                ),

                node(
                    'div',
                    'history-meta',
                    `${e.changedBy} · ${date(e.createdAt)}`
                ),

                node(
                    'div',
                    'history-notes',
                    e.notes || ''
                )
            );

            n.append(
                node('span', 'history-dot'),
                c
            );

            h.append(n);
        }

        state.notePage = 1;

        await notes();
    }

    async function notes(append = false) {
        const d = await api(
            'notes',
            'GET',
            null,

            {
                id: state.id,
                page: state.notePage,
                limit: 25
            }
        );

        state.notes = append
            ? [
                ...state.notes,
                ...(d.notes || [])
            ]
            : d.notes || [];

        const root = $('applicantNotes');

        root.replaceChildren();

        for (const n of state.notes) {
            const card = node(
                'article',
                'note-card'
            );

            const head = node(
                'div',
                'note-header'
            );

            const who = node('div');

            const actions = node(
                'div',
                'note-actions'
            );

            who.append(
                node(
                    'div',
                    'note-author',
                    n.author
                ),

                node(
                    'div',
                    'note-date',
                    date(n.updatedAt)
                )
            );

            if (n.permissions?.edit) {
                actions.append(
                    button('Edit', () => {
                        state.editNote = n;

                        $('editNoteInput').value = n.note;

                        $('editNoteDialog').showModal();
                    })
                );
            }

            if (n.permissions?.delete) {
                actions.append(
                    button('Delete', async () => {
                        if (!await confirmAction(
                            'Delete note',
                            'This permanently deletes the private note.'
                        )) {
                            return;
                        }

                        await api(
                            'notes',
                            'DELETE',

                            {
                                applicationId: state.id,
                                noteId: n.id,
                                expectedUpdatedAt: n.updatedAt
                            }
                        );

                        state.notePage = 1;

                        await notes();

                        toast('Note deleted');
                    })
                );
            }

            head.append(who, actions);

            card.append(
                head,

                node(
                    'div',
                    'note-content',
                    n.note
                )
            );

            root.append(card);
        }

        if (!state.notes.length) {
            root.append(
                node(
                    'div',
                    'empty-state',
                    'No private notes yet.'
                )
            );
        }

        show(
            'loadMoreNotes',
            state.notePage <
            (d.pagination?.totalPages ?? 1)
        );
    }

    async function activity() {
        const d = await api(
            'activity',
            'GET',
            null,

            {
                page: state.pages.activity,
                limit: 25,
                search: $('activitySearch').value,
                actor: $('activityActorFilter').value,
                action: $('activityActionFilter').value,
                targetType: $('activityTargetFilter').value,
                sort: $('activitySort').value
            }
        );

        const s = d.statistics || d.stats || {};

        for (const [id, k] of Object.entries({
            activityTotal: 'total',
            activityAdministrators: 'administrators',
            activityLast24Hours: 'last24Hours',
            activityLast7Days: 'last7Days'
        })) {
            text(id, s[k] ?? 0);
        }

        options(
            'activityActorFilter',
            d.availableFilters?.actors
        );

        options(
            'activityActionFilter',
            d.availableFilters?.actions
        );

        options(
            'activityTargetFilter',
            d.availableFilters?.targetTypes
        );

        pagination(
            'activity',
            d.pagination || {}
        );

        rows(
            'activityTableBody',
            d.activity || [],
            5,

            a => [
                label(a.action),
                a.actor,

                [a.targetType, a.targetId]
                    .filter(Boolean)
                    .join(' · '),

                date(a.createdAt),

                button('Details', () => {
                    const dl = $('activityDetailFields');

                    dl.replaceChildren();

                    for (const k of [
                        'id',
                        'actor',
                        'action',
                        'targetType',
                        'targetId',
                        'createdAt'
                    ]) {
                        const n = node('div');

                        n.append(
                            node(
                                'dt',
                                '',
                                label(k)
                            ),

                            node(
                                'dd',
                                '',
                                a[k]
                            )
                        );

                        dl.append(n);
                    }

                    text(
                        'activityDetailJson',
                        JSON.stringify(
                            a.details,
                            null,
                            2
                        )
                    );

                    $('activityDetailDialog').showModal();
                })
            ]
        );
    }

    function preview() {
        const open =
            $('recruitmentOpenToggle').checked;

        text(
            'settingsPreviewTitle',
            $('recruitmentTitleInput').value
        );

        text(
            'settingsPreviewMessage',
            $('recruitmentMessageInput').value
        );

        text(
            'recruitmentMessageCount',
            `${$('recruitmentMessageInput').value.length} / 1000`
        );

        badge(
            $('settingsPreviewStatus'),
            open ? 'open' : 'closed'
        );

        show(
            'recruitmentOpeningWarning',
            open &&
            !state.settings?.recruitment?.open
        );
    }

    function populateSettings() {
        const d = state.settings;

        const r = d.recruitment;

        $('recruitmentOpenToggle').checked = r.open;

        $('recruitmentTitleInput').value = r.title;

        $('recruitmentMessageInput').value = r.message;

        text(
            'settingsPrivacyVersion',
            r.privacyVersion
        );

        text(
            'settingsSource',

            d.source ??
            d.configuration?.source ??
            r.source ??
            'Database / environment'
        );

        const root = $('settingsMetadata');

        root.replaceChildren();

        for (const [k, v] of Object.entries(
            d.metadata || {}
        )) {
            const n = node(
                'div',
                'metadata-item'
            );

            n.append(
                node(
                    'div',
                    'metadata-key',
                    label(k)
                ),

                node(
                    'div',
                    'metadata-value',

                    typeof v === 'object'
                        ? JSON.stringify(v)
                        : v
                )
            );

            root.append(n);
        }

        preview();
        recruitment(r);
    }

    async function settings() {
        state.settings = await api('settings');

        populateSettings();
    }

    function confirmAction(title, message) {
        return new Promise(resolve => {
            const d = $('confirmDialog');

            text(
                'confirmDialogTitle',
                title
            );

            text(
                'confirmDialogMessage',
                message
            );

            d.returnValue = 'cancel';

            d.addEventListener(
                'close',

                () => resolve(
                    d.returnValue === 'confirm'
                ),

                { once: true }
            );

            d.showModal();
        });
    }

    async function navigate(view, id) {
        if (![
            'overview',
            'applications',
            'application',
            'interviews',
            'activity',
            'settings'
        ].includes(view)) {
            view = 'overview';
        }

        state.view = view;

        if (id) state.id = id;

        document.querySelectorAll(
            '.page-view'
        ).forEach(n => {
            n.hidden = n.id !== 'view-' + view;
        });

        document.querySelectorAll(
            '.nav-item[data-view]'
        ).forEach(n => {
            n.classList.toggle(
                'active',

                n.dataset.view === (
                    view === 'application'
                        ? 'applications'
                        : view
                )
            );
        });

        text(
            'breadcrumbCurrent',
            label(view)
        );

        $('sidebar').classList.remove(
            'open',
            'active'
        );

        show('sidebarOverlay', false);

        await ({
            overview,

            applications: () => applications(),

            application: profile,

            interviews: () => applications(true),

            activity,

            settings
        }[view])();
    }

    function bind(id, event, fn) {
        $(id).addEventListener(event, e => {
            if (event === 'submit') {
                e.preventDefault();
            }

            run(() => fn(e));
        });
    }

    function wire() {
        document.querySelectorAll(
            '[data-view]'
        ).forEach(n => {
            n.addEventListener('click', e => {
                e.preventDefault();

                run(
                    () => navigate(n.dataset.view)
                );
            });
        });

        document.querySelectorAll(
            '[data-close-dialog]'
        ).forEach(n => {
            n.addEventListener('click', () => {
                $(n.dataset.closeDialog).close(
                    'cancel'
                );
            });
        });

        $('confirmDialogCancel').onclick = () => {
            $('confirmDialog').close('cancel');
        };

        $('confirmDialogAccept').onclick = () => {
            $('confirmDialog').close('confirm');
        };

        $('dismissErrorButton').onclick = () => {
            show('globalError', false);
        };

        $('mobileMenuButton').onclick = () => {
            $('sidebar').classList.add(
                'open',
                'active'
            );

            show('sidebarOverlay');
        };

        $('sidebarOverlay').onclick = () => {
            $('sidebar').classList.remove(
                'open',
                'active'
            );

            show('sidebarOverlay', false);
        };

        $('logoutButton').onclick = () => {
            location.assign(
                '/cdn-cgi/access/logout'
            );
        };

        $('retryConnectionButton').onclick = () => {
            location.reload();
        };

        bind(
            'refreshButton',
            'click',
            () => navigate(state.view)
        );

        bind(
            'backToApplicants',
            'click',
            () => navigate('applications')
        );

        for (const prefix of [
            'applications',
            'interviews',
            'activity'
        ]) {
            for (const [suffix, delta] of [
                ['PreviousPage', -1],
                ['NextPage', 1]
            ]) {
                bind(
                    prefix + suffix,
                    'click',

                    () => {
                        state.pages[prefix] = Math.max(
                            1,
                            state.pages[prefix] + delta
                        );

                        return navigate(prefix);
                    }
                );
            }
        }

        bind(
            'applicationFilters',
            'submit',

            () => {
                state.pages.applications = 1;

                return applications();
            }
        );

        bind(
            'clearApplicationFilters',
            'click',

            () => {
                $('applicationFilters').reset();

                state.pages.applications = 1;

                return applications();
            }
        );

        bind(
            'activityFilters',
            'submit',

            () => {
                state.pages.activity = 1;

                return activity();
            }
        );

        bind(
            'clearActivityFilters',
            'click',

            () => {
                $('activityFilters').reset();

                state.pages.activity = 1;

                return activity();
            }
        );

        bind(
            'changeStatusButton',
            'click',

            () => {
                const a = state.application;

                text(
                    'statusDialogApplicant',
                    a.displayName
                );

                badge(
                    $('statusDialogCurrent'),
                    a.status
                );

                const sel = $('statusDialogSelect');

                sel.replaceChildren();

                for (const s of transitions[a.status] || []) {
                    sel.add(
                        new Option(label(s), s)
                    );
                }

                $('statusDialogNotes').value = '';

                const terminal = [
                    'accepted',
                    'declined',
                    'withdrawn'
                ].includes(a.status);

                $('statusDialogNotes').required =
                    terminal;

                show(
                    'statusReopenWarning',
                    terminal
                );

                $('statusDialog').showModal();
            }
        );

        bind(
            'statusChangeForm',
            'submit',

            async () => {
                const a = state.application;

                await api(
                    'status',
                    'POST',

                    {
                        applicationId: a.applicationId,

                        status:
                            $('statusDialogSelect').value,

                        expectedStatus:
                            a.status,

                        expectedUpdatedAt:
                            a.updatedAt,

                        notes:
                            $('statusDialogNotes').value.trim()
                    }
                );

                $('statusDialog').close();

                await profile();

                toast('Application status updated');
            }
        );

        $('newNote').addEventListener(
            'input',

            () => text(
                'noteCharacterCount',
                `${$('newNote').value.length} / 5000`
            )
        );

        bind(
            'createNoteForm',
            'submit',

            async () => {
                const note =
                    $('newNote').value.trim();

                if (!note) {
                    throw Error('Enter a note.');
                }

                await api(
                    'notes',
                    'POST',

                    {
                        applicationId: state.id,
                        note
                    }
                );

                $('newNote').value = '';

                text(
                    'noteCharacterCount',
                    '0 / 5000'
                );

                state.notePage = 1;

                await notes();

                toast('Note created');
            }
        );

        bind(
            'editNoteForm',
            'submit',

            async () => {
                const n = state.editNote;

                await api(
                    'notes',
                    'PATCH',

                    {
                        applicationId: state.id,

                        noteId: n.id,

                        note:
                            $('editNoteInput').value.trim(),

                        expectedUpdatedAt:
                            n.updatedAt
                    }
                );

                $('editNoteDialog').close();

                state.notePage = 1;

                await notes();

                toast('Note updated');
            }
        );

        bind(
            'loadMoreNotes',
            'click',

            async () => {
                state.notePage++;

                try {
                    await notes(true);
                } catch (e) {
                    state.notePage--;

                    throw e;
                }
            }
        );

        for (const id of [
            'recruitmentOpenToggle',
            'recruitmentTitleInput',
            'recruitmentMessageInput'
        ]) {
            $(id).addEventListener(
                'input',
                preview
            );
        }

        bind(
            'resetSettingsButton',
            'click',
            populateSettings
        );

        bind(
            'recruitmentSettingsForm',
            'submit',

            async () => {
                const open =
                    $('recruitmentOpenToggle').checked;

                if (
                    open &&
                    !state.settings.recruitment.open &&
                    !await confirmAction(
                        'Open recruitment',
                        'Allow public application submissions?'
                    )
                ) {
                    return;
                }

                await api(
                    'settings',
                    'PATCH',

                    {
                        settings: {
                            applications_open: open,

                            recruitment_title:
                                $('recruitmentTitleInput')
                                    .value.trim(),

                            recruitment_message:
                                $('recruitmentMessageInput')
                                    .value.trim()
                        },

                        confirmOpen: open
                    }
                );

                await settings();

                toast('Recruitment settings saved');
            }
        );
    }

    async function init() {
        try {
            wire();

            const d = await api('session');

            const a = d.administrator;

            if (!a?.email) {
                throw Error(
                    'Administrator identity unavailable.'
                );
            }

            text(
                'administratorEmail',
                a.email
            );

            text(
                'administratorName',
                a.role || 'Administrator'
            );

            text(
                'administratorAvatar',
                a.email[0].toUpperCase()
            );

            text(
                'footerApiVersion',
                d.version || '1.0.0'
            );

            await overview();

            show('loadingScreen', false);
            show('adminApp');

        } catch (e) {
            show('loadingScreen', false);
            show('adminApp', false);

            text(
                'fatalErrorMessage',
                e.message
            );

            show('fatalErrorScreen');
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener(
            'DOMContentLoaded',
            init,
            { once: true }
        );
    } else {
        init();
    }
})();
