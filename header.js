/* Shared presentation shell. Existing links, controls and handlers are moved intact. */
(() => {
    'use strict';

    const header = document.querySelector('header.kz-header');
    const nav = header?.querySelector('.kz-nav');
    const brand = header?.querySelector('.kz-brand');
    if (!header || !nav || !brand) return;

    const root = document.documentElement;
    const main = document.querySelector('body > main');
    const headerRow = header.firstElementChild;
    const context = brand.parentElement;
    const toolbar = [...headerRow.children].find(child => child !== context);
    const mobile = window.matchMedia('(max-width: 899px)');
    const preferenceKey = 'kuzgun_sidebar_collapsed';
    const paths = {
        terminal: '<rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1.5"/><rect x="14" y="3.5" width="6.5" height="6.5" rx="1.5"/><rect x="3.5" y="14" width="6.5" height="6.5" rx="1.5"/><rect x="14" y="14" width="6.5" height="6.5" rx="1.5"/>',
        laboratory: '<path d="M9 3h6M10 3v6l-5.8 9.2A1.8 1.8 0 0 0 5.7 21h12.6a1.8 1.8 0 0 0 1.5-2.8L14 9V3M7.5 14h9"/>',
        wizard: '<path d="m4 20 10-10 3 3L7 23M12 12l3 3M6 3v4M4 5h4M18 2v4M16 4h4M20 17v4M18 19h4"/>',
        combination: '<rect x="3.5" y="3.5" width="11" height="11" rx="2"/><rect x="9.5" y="9.5" width="11" height="11" rx="2"/>',
        settings: '<path d="m9.6 3-.5 2a7 7 0 0 0-1.7 1l-2-.6-2.3 4 1.5 1.5a7 7 0 0 0 0 2.2l-1.5 1.5 2.3 4 2-.6a7 7 0 0 0 1.7 1l.5 2h4.8l.5-2a7 7 0 0 0 1.7-1l2 .6 2.3-4-1.5-1.5a7 7 0 0 0 0-2.2l1.5-1.5-2.3-4-2 .6a7 7 0 0 0-1.7-1l-.5-2z"/><circle cx="12" cy="12" r="3"/>',
        panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
        menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
        close: '<path d="m6 6 12 12M6 18 18 6"/>',
        appearance: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
        arrow: '<path d="m9 5 7 7-7 7"/>'
    };
    const icon = name => `<svg class="kz-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
    const button = (className, label, name) => {
        const node = document.createElement('button');
        node.type = 'button';
        node.className = className;
        node.setAttribute('aria-label', label);
        node.title = label;
        node.innerHTML = icon(name);
        return node;
    };

    const sidebar = document.createElement('aside');
    sidebar.id = 'kzSidebar';
    sidebar.className = 'kz-sidebar';
    sidebar.setAttribute('aria-label', 'Çalışma alanı menüsü');
    const sidebarTop = document.createElement('div');
    sidebarTop.className = 'kz-sidebar-top';
    brand.classList.add('kz-sidebar-brand');
    brand.innerHTML = '<span class="kz-brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 5v14M17 5 9 13M11 11l6 8"/></svg></span><span class="kz-brand-name">KUZGUN</span>';
    brand.setAttribute('aria-label', 'KUZGUN Terminal');
    const collapse = button('kz-shell-button kz-sidebar-toggle', 'Menüyü daralt', 'panel');
    collapse.setAttribute('aria-controls', sidebar.id);
    sidebarTop.append(brand, collapse);
    const sectionLabel = document.createElement('p');
    sectionLabel.className = 'kz-nav-caption';
    sectionLabel.textContent = 'Çalışma alanı';
    const navIcons = ['terminal', 'laboratory', 'wizard', 'combination', 'settings'];
    const items = [...nav.children];
    const active = items.find(item => item.getAttribute('aria-current') === 'page');
    const pageTitle = active?.textContent.trim() || 'Coin odağı';
    for (const [index, item] of items.entries()) {
        const text = item.textContent.trim();
        item.setAttribute('aria-label', text);
        item.title = text;
        item.innerHTML = icon(navIcons[index] || 'terminal') + `<span class="kz-nav-text">${text}</span>`;
        if (item === active) item.insertAdjacentHTML('beforeend', '<span class="kz-nav-active-mark" aria-hidden="true"></span>');
    }
    const footer = document.createElement('div');
    footer.className = 'kz-sidebar-footer';
    const settingsLink = items.find(item => item.getAttribute('href') === 'settings.html');
    if (settingsLink) {
        settingsLink.classList.add('kz-sidebar-setting');
        footer.append(settingsLink);
    }
    let themeButton = header.querySelector('button[onclick*="cycleTheme"]');
    if (themeButton) {
        const original = document.createElement('span');
        original.className = 'kz-theme-original';
        original.append(...themeButton.childNodes);
        themeButton.append(original);
    } else {
        themeButton = document.createElement('button');
        themeButton.type = 'button';
        themeButton.addEventListener('click', () => {
            const theme = root.classList.contains('oled') ? 'light' : root.classList.contains('dark') ? 'oled' : 'dark';
            root.classList.toggle('dark', theme !== 'light');
            root.classList.toggle('oled', theme === 'oled');
            localStorage.setItem('kuzgun_theme', theme);
        });
    }
    themeButton.className = 'kz-sidebar-appearance';
    themeButton.setAttribute('aria-label', 'Görünümü değiştir. Açık, koyu ve OLED.');
    themeButton.insertAdjacentHTML('afterbegin', icon('appearance') + '<span class="kz-nav-text">Görünüm</span><span class="kz-theme-value"><span class="kz-theme-light">Açık</span><span class="kz-theme-dark">Koyu</span><span class="kz-theme-oled">OLED</span></span>');
    footer.append(themeButton);
    const workspaceNote = document.createElement('div');
    workspaceNote.className = 'kz-workspace-note';
    workspaceNote.innerHTML = '<span class="kz-workspace-initial" aria-hidden="true">K</span><div class="kz-nav-text"><strong>Kişisel çalışma alanı</strong><span>Binance Spot</span></div>';
    footer.append(workspaceNote);
    sidebar.append(sidebarTop, sectionLabel, nav, footer);
    const backdrop = button('kz-sidebar-backdrop', 'Menüyü kapat', 'close');
    backdrop.tabIndex = -1;
    document.body.prepend(sidebar, backdrop);

    context.className = 'kz-header-context';
    const mobileToggle = button('kz-shell-button kz-mobile-toggle', 'Menüyü aç', 'menu');
    mobileToggle.setAttribute('aria-controls', sidebar.id);
    const breadcrumb = document.createElement('div');
    breadcrumb.className = 'kz-breadcrumb';
    const parent = document.createElement('span');
    parent.className = 'kz-breadcrumb-parent';
    parent.textContent = 'Çalışma alanı';
    const current = document.createElement('span');
    current.textContent = pageTitle;
    breadcrumb.append(parent);
    breadcrumb.insertAdjacentHTML('beforeend', icon('arrow'));
    breadcrumb.append(current);
    context.append(mobileToggle, breadcrumb);
    toolbar?.classList.add('kz-header-toolbar');

    let collapsed = false;
    try { collapsed = localStorage.getItem(preferenceKey) === 'true'; } catch (_) {}
    const setMobileOpen = (open, restoreFocus = true) => {
        root.classList.toggle('kz-menu-open', open);
        sidebar.inert = mobile.matches && !open;
        if (main) main.inert = open;
        header.inert = open;
        mobileToggle.setAttribute('aria-expanded', String(open));
        if (open) collapse.focus();
        else if (restoreFocus && mobile.matches) mobileToggle.focus();
    };
    const syncLayout = () => {
        setMobileOpen(false, false);
        root.classList.toggle('kz-sidebar-collapsed', collapsed);
        const label = mobile.matches ? 'Menüyü kapat' : collapsed ? 'Menüyü genişlet' : 'Menüyü daralt';
        collapse.setAttribute('aria-label', label);
        collapse.title = label;
        collapse.setAttribute('aria-expanded', String(mobile.matches ? true : !collapsed));
    };
    collapse.addEventListener('click', () => {
        if (mobile.matches) { setMobileOpen(false); return; }
        collapsed = !collapsed;
        try { localStorage.setItem(preferenceKey, String(collapsed)); } catch (_) {}
        syncLayout();
    });
    mobileToggle.addEventListener('click', () => setMobileOpen(true));
    backdrop.addEventListener('click', () => setMobileOpen(false));
    sidebar.addEventListener('click', event => {
        if (mobile.matches && event.target.closest('a, .kz-nav button')) setMobileOpen(false, false);
    }, true);
    document.addEventListener('keydown', event => {
        if (!mobile.matches || !root.classList.contains('kz-menu-open')) return;
        if (event.key === 'Escape') { event.preventDefault(); setMobileOpen(false); }
        if (event.key === 'Tab') {
            const controls = [...sidebar.querySelectorAll('a, button')].filter(node => node.getClientRects().length > 0);
            const first = controls[0], last = controls.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
    });
    mobile.addEventListener('change', syncLayout);
    window.addEventListener('pageshow', syncLayout);
    syncLayout();
    root.classList.add('kz-sidebar-ready');
})();
