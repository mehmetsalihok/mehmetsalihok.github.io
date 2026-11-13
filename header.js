/* Sidebar markup and the initial theme are rendered by each HTML page. */
(() => {
    'use strict';

    const root = document.documentElement;
    const sidebar = document.getElementById('kzSidebar');
    const header = document.querySelector('header.kz-header');
    if (!sidebar || !header) return;
    const main = document.querySelector('body > main');
    const collapse = sidebar.querySelector('.kz-sidebar-toggle');
    const mobileToggle = header.querySelector('.kz-mobile-toggle');
    const backdrop = document.querySelector('.kz-sidebar-backdrop');
    const mobile = matchMedia('(max-width: 899px)');
    const preferenceKey = 'kuzgun_sidebar_collapsed';

    function setMobileOpen(open, restoreFocus = true) {
        root.classList.toggle('kz-menu-open', open);
        sidebar.inert = mobile.matches && !open;
        if (main) main.inert = open;
        header.inert = open;
        mobileToggle.setAttribute('aria-expanded', String(open));
        if (open) collapse.focus();
        else if (restoreFocus && mobile.matches) mobileToggle.focus();
    }

    function syncLayout() {
        setMobileOpen(false, false);
        const collapsed = root.classList.contains('kz-sidebar-collapsed');
        const label = mobile.matches ? 'Menüyü kapat' : collapsed ? 'Menüyü genişlet' : 'Menüyü daralt';
        collapse.setAttribute('aria-label', label);
        collapse.title = label;
        collapse.setAttribute('aria-expanded', String(mobile.matches || !collapsed));
    }

    collapse.addEventListener('click', () => {
        if (mobile.matches) {
            setMobileOpen(false);
            return;
        }
        const collapsed = root.classList.toggle('kz-sidebar-collapsed');
        try { localStorage.setItem(preferenceKey, String(collapsed)); } catch (_) {}
        syncLayout();
    });
    mobileToggle.addEventListener('click', () => setMobileOpen(true));
    backdrop.addEventListener('click', () => setMobileOpen(false));
    sidebar.addEventListener('click', event => {
        if (mobile.matches && event.target.closest('a, .kz-nav button')) setMobileOpen(false, false);
    }, true);
    document.addEventListener('keydown', event => {
        if (!root.classList.contains('kz-menu-open')) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            setMobileOpen(false);
        }
        if (event.key === 'Tab') {
            const controls = [...sidebar.querySelectorAll('a, button')].filter(node => node.getClientRects().length > 0);
            const first = controls[0];
            const last = controls.at(-1);
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        }
    });

    sidebar.querySelector('[data-kz-cycle-theme]')?.addEventListener('click', () => {
        const theme = root.classList.contains('oled') ? 'light' : root.classList.contains('dark') ? 'oled' : 'dark';
        root.classList.toggle('dark', theme !== 'light');
        root.classList.toggle('oled', theme === 'oled');
        try { localStorage.setItem('kuzgun_theme', theme); } catch (_) {}
    });

    mobile.addEventListener('change', syncLayout);
    window.addEventListener('pageshow', syncLayout);
    syncLayout();
})();
