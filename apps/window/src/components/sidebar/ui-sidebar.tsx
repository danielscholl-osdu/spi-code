// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT
//
// Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

/** Below this width the sidebar leaves the grid and opens off-canvas over the middle frame. */
export const NARROW_LAYOUT_MEDIA_QUERY = "(max-width: 979px)";

function isNarrowViewport(): boolean {
  return window.matchMedia(NARROW_LAYOUT_MEDIA_QUERY).matches;
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", listener);
      return () => list.removeEventListener("change", listener);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

// An off-canvas sidebar turns inert once it closes, which would drop focus to the body.
function moveFocusOutOfClosingSidebar() {
  const sidebar = document.activeElement?.closest<HTMLElement>('[data-slot="sidebar"]');
  focusTrigger(sidebar);
}

function focusTrigger(sidebar: HTMLElement | null | undefined) {
  const wrapper = sidebar?.closest<HTMLElement>('[data-slot="sidebar-wrapper"]');
  if (!sidebar || !wrapper) return;
  const trigger = Array.from(
    wrapper.querySelectorAll<HTMLElement>('[data-sidebar="trigger"]'),
  ).find((element) => !sidebar.contains(element));
  trigger?.focus({ preventScroll: true });
}

type SidebarOpenState = { readonly open: boolean; readonly openMobile: boolean };

export function createSidebarOpenStore(defaultOpen = true) {
  let state: SidebarOpenState = { open: defaultOpen, openMobile: false };
  const listeners = new Set<() => void>();
  const publish = (next: SidebarOpenState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const setOpen = (open: boolean) => {
    if (!open && state.open) moveFocusOutOfClosingSidebar();
    if (open !== state.open) publish({ ...state, open });
  };
  const setOpenMobile = (openMobile: boolean) => {
    if (!openMobile && state.openMobile) moveFocusOutOfClosingSidebar();
    if (openMobile !== state.openMobile) publish({ ...state, openMobile });
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => state,
    setOpen,
    setOpenMobile,
    toggle: () => (isNarrowViewport() ? setOpenMobile(!state.openMobile) : setOpen(!state.open)),
  };
}

type SidebarContextValue = {
  isMobile: boolean;
  open: boolean;
  openMobile: boolean;
  /** Whether the sidebar is on screen, in the grid or off-canvas. */
  visible: boolean;
  setOpen(open: boolean): void;
  setOpenMobile(open: boolean): void;
  toggleSidebar(): void;
};

const SidebarContext = createContext<SidebarContextValue | null>(null);

export function useSidebar(): SidebarContextValue {
  const context = useContext(SidebarContext);
  if (!context) throw new Error("useSidebar must be used within a SidebarProvider.");
  return context;
}

export function SidebarProvider({
  defaultOpen = true,
  children,
  ...props
}: ComponentProps<"div"> & { defaultOpen?: boolean }) {
  const [store] = useState(() => createSidebarOpenStore(defaultOpen));
  const { open, openMobile } = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const isMobile = useMediaQuery(NARROW_LAYOUT_MEDIA_QUERY);
  useEffect(() => {
    if (!isMobile && store.getSnapshot().openMobile) store.setOpenMobile(false);
  }, [isMobile, store]);
  const visible = isMobile ? openMobile : open;
  return (
    <SidebarContext
      value={{
        isMobile,
        open,
        openMobile,
        visible,
        setOpen: store.setOpen,
        setOpenMobile: store.setOpenMobile,
        toggleSidebar: store.toggle,
      }}
    >
      <div
        data-slot="sidebar-wrapper"
        data-sidebar-state={visible ? "expanded" : "collapsed"}
        data-layout={isMobile ? "narrow" : "wide"}
        {...props}
      >
        {children}
      </div>
    </SidebarContext>
  );
}

export function Sidebar({ children, ...props }: ComponentProps<"nav">) {
  const { isMobile, openMobile, visible, setOpenMobile } = useSidebar();
  const ref = useRef<HTMLElement>(null);
  const offCanvas = isMobile && openMobile;
  useEffect(() => {
    if (!offCanvas) return;
    ref.current
      ?.querySelector<HTMLElement>("button:not([inert]), a[href]")
      ?.focus({ preventScroll: true });
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setOpenMobile(false);
      focusTrigger(ref.current);
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [offCanvas, setOpenMobile]);
  return (
    <>
      {offCanvas && (
        <div
          aria-hidden
          className="sidebar-backdrop"
          data-slot="sidebar-backdrop"
          onClick={() => setOpenMobile(false)}
        />
      )}
      <nav
        ref={ref}
        data-slot="sidebar"
        data-sidebar="sidebar"
        data-state={visible ? "expanded" : "collapsed"}
        data-mobile={isMobile ? "true" : undefined}
        inert={!visible}
        {...props}
      >
        {children}
      </nav>
    </>
  );
}

export function SidebarHeader(props: ComponentProps<"div">) {
  return <div data-sidebar="header" data-slot="sidebar-header" {...props} />;
}

export function SidebarContent(props: ComponentProps<"div">) {
  return <div data-sidebar="content" data-slot="sidebar-content" {...props} />;
}

export function SidebarGroup(props: ComponentProps<"div">) {
  return <div data-sidebar="group" data-slot="sidebar-group" {...props} />;
}

export function SidebarMenu(props: ComponentProps<"ul">) {
  return <ul data-sidebar="menu" data-slot="sidebar-menu" {...props} />;
}

export function SidebarMenuItem(props: ComponentProps<"li">) {
  return <li data-sidebar="menu-item" data-slot="sidebar-menu-item" {...props} />;
}

export function SidebarMenuButton({
  isActive = false,
  ...props
}: ComponentProps<"button"> & { isActive?: boolean }) {
  return (
    <button
      type="button"
      data-active={isActive}
      data-sidebar="menu-button"
      data-slot="sidebar-menu-button"
      aria-current={isActive ? "page" : undefined}
      {...props}
    />
  );
}

export function SidebarFooter(props: ComponentProps<"div">) {
  return <div data-sidebar="footer" data-slot="sidebar-footer" {...props} />;
}

export function SidebarTrigger({
  onClick,
  children,
  ...props
}: Omit<ComponentProps<"button">, "aria-pressed">) {
  const { toggleSidebar, visible } = useSidebar();
  return (
    <button
      type="button"
      data-sidebar="trigger"
      data-slot="sidebar-trigger"
      aria-pressed={visible}
      onClick={(event) => {
        onClick?.(event);
        toggleSidebar();
      }}
      {...props}
    >
      {children}
    </button>
  );
}

/** A group header that folds its group: the label, a rule or a count, and a chevron. */
export function CollapsibleSectionHeader({
  children,
  expanded,
  accessory,
  ...buttonProps
}: Omit<ComponentProps<"button">, "aria-expanded"> & {
  expanded: boolean;
  accessory?: ReactNode;
}) {
  return (
    <button
      type="button"
      className="section-header"
      data-slot="section-header"
      aria-expanded={expanded}
      {...buttonProps}
    >
      <span className="section-header-label">{children}</span>
      {accessory === undefined ? (
        <span aria-hidden className="section-header-rule" />
      ) : (
        <span className="section-header-count">{accessory}</span>
      )}
      <span aria-hidden className="section-header-chevron" data-expanded={expanded} />
    </button>
  );
}
