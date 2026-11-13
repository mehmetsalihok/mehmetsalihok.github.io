/* Sidebar markup and the initial theme are rendered by each HTML page. */
(() => {
    'use strict';

    const root = document.documentElement;
    const sidebar = document.getElementById('kzSidebar');
    const header = document.querySelector('header.kz-header');
    if (!sidebar || !header) return;
    const main = document.querySelector('body > main');
    const collapse = sidebar.querySelector('.kz-sidebar-toggle');
    const resize = document.querySelector('.kz-sidebar-resize');
    const mobileToggle = header.querySelector('.kz-mobile-toggle');
    const backdrop = document.querySelector('.kz-sidebar-backdrop');
    const mobile = matchMedia('(max-width: 899px)');
    const widthKey = 'kuzgun_sidebar_width';
    const expandedWidthKey = 'kuzgun_sidebar_expanded_width';
    const minimumWidth = Number(resize.getAttribute('aria-valuemin'));
    const maximumWidth = Number(resize.getAttribute('aria-valuemax'));
    const defaultWidth = Number(resize.getAttribute('aria-valuenow'));
    let width = parseInt(root.style.getPropertyValue('--kz-sidebar-width'), 10) || defaultWidth;
    let expandedWidth = defaultWidth;
    let drag = null;
    let ignorePointerClick = false;

    function readExpandedWidth() {
        try {
            const savedWidth = Number(localStorage.getItem(expandedWidthKey));
            if (savedWidth > minimumWidth && savedWidth <= maximumWidth) expandedWidth = savedWidth;
        } catch (_) {}
    }

    function setWidth(value) {
        width = Math.min(maximumWidth, Math.max(minimumWidth, Math.round(value)));
        root.style.setProperty('--kz-sidebar-width', width + 'px');
        resize.setAttribute('aria-valuenow', String(width));
        const collapsed = width === minimumWidth;
        const label = mobile.matches ? 'Menüyü kapat' : collapsed ? 'Menüyü genişlet' : 'Menüyü daralt';
        collapse.setAttribute('aria-label', label);
        collapse.title = label;
        collapse.setAttribute('aria-expanded', String(mobile.matches || !collapsed));
    }

    function saveWidth() {
        if (width > minimumWidth) expandedWidth = width;
        try {
            localStorage.setItem(widthKey, String(width));
            localStorage.setItem(expandedWidthKey, String(expandedWidth));
        } catch (_) {}
    }

    function finishDrag(cancelled) {
        const activeDrag = drag;
        drag = null;
        if (!activeDrag || !activeDrag.moved) return;
        root.classList.remove('kz-sidebar-resizing');
        if (cancelled) setWidth(activeDrag.width);
        else saveWidth();
        ignorePointerClick = activeDrag.control === collapse;
    }

    for (const control of [resize, collapse]) {
        control.addEventListener('pointerdown', event => {
            if (mobile.matches || event.button !== 0 || drag) return;
            ignorePointerClick = false;
            drag = {control, id: event.pointerId, start: event.clientX, width, moved: false};
            control.setPointerCapture(event.pointerId);
        });
        control.addEventListener('pointermove', event => {
            if (drag?.id !== event.pointerId) return;
            const distance = event.clientX - drag.start;
            if (!drag.moved && Math.abs(distance) < 5) return;
            drag.moved = true;
            root.classList.add('kz-sidebar-resizing');
            setWidth(drag.width + distance);
        });
        control.addEventListener('pointerup', event => {
            if (drag?.id === event.pointerId) finishDrag(false);
        });
        control.addEventListener('lostpointercapture', event => {
            if (drag?.id === event.pointerId) finishDrag(true);
        });
    }

    resize.addEventListener('keydown', event => {
        const widths = {ArrowLeft: width - 12, ArrowRight: width + 12, Home: minimumWidth, End: maximumWidth};
        if (!Object.hasOwn(widths, event.key)) return;
        event.preventDefault();
        setWidth(widths[event.key]);
        saveWidth();
    });

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
        finishDrag(true);
        setMobileOpen(false, false);
        setWidth(width);
    }

    collapse.addEventListener('click', event => {
        if (ignorePointerClick && event.detail > 0) {
            ignorePointerClick = false;
            return;
        }
        if (mobile.matches) {
            setMobileOpen(false);
            return;
        }
        setWidth(width === minimumWidth ? expandedWidth : minimumWidth);
        saveWidth();
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
    window.addEventListener('pageshow', event => {
        if (event.persisted) {
            try {
                const savedWidth = Number(localStorage.getItem(widthKey));
                if (savedWidth >= minimumWidth && savedWidth <= maximumWidth) width = savedWidth;
            } catch (_) {}
            readExpandedWidth();
        }
        syncLayout();
    });
    readExpandedWidth();
    syncLayout();
})();
