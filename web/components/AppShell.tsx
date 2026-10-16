"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getMe, MOCK, postLogout } from "@/lib/api";
import { prefetchFor } from "@/lib/resources";
import { hasModifier, isTypingTarget } from "@/lib/keys";
import { buildDefaultActions } from "@/lib/palette";
import { useNavCollapsed } from "@/lib/nav";
import { useSkin } from "@/lib/skin";
import { setTestMode } from "@/lib/testMode";
import type { AuthUser } from "@/lib/types";
import { CommandPalette, ToastProvider, useToast } from "./rich";
import { ShortcutsOverlay } from "./Shortcuts";
import { ThemeToggle, useThemeMode } from "./ThemeToggle";
import type { ThemeMode } from "./ThemeToggle";
import { Kbd } from "./ui";

/**
 * The destinations, in the order a day actually uses them.
 *
 * Approve is deliberately absent. Cards used to queue for triage before they
 * could be studied; they are now checked in the pipeline (grounded against
 * the source they came from, or fact-checked when there is no source) and go
 * straight into rotation. A bad one is caught where the evidence is — in
 * review, where you press one key to suspend it.
 */
const NAV = [
  { href: "/", label: "Today" },
  { href: "/review", label: "Review" },
  // Between Review and Test because that is where the need appears: review is
  // where you find out you do not actually understand unit 2, and a lesson is
  // upstream of the paper you sit once you think you do.
  { href: "/learn", label: "Learn" },
  { href: "/test", label: "Test" },
  { href: "/upload", label: "Upload" },
  { href: "/sources", label: "Sources" },
  { href: "/settings", label: "Settings" },
];

/** `g` then a letter. Vim's idiom, and it keeps single letters free for pages. */
const GOTO: Record<string, string> = {
  d: "/",
  r: "/review",
  l: "/learn",
  t: "/test",
  u: "/upload",
  o: "/sources",
  s: "/settings",
};

/**
 * Publishes the sidebar state to CSS as `data-nav` on <html>.
 *
 * The widths live in globals.css against a media query, so the browser owns
 * the breakpoint and React owns only the preference. Writing an attribute is
 * the whole job — no layout measurement crosses into JS, which is what kept
 * the content sliding under the sidebar when it did.
 */
function NavState({ collapsed, drawerOpen }: {
  collapsed: boolean;
  drawerOpen: boolean;
}) {
  useEffect(() => {
    const el = document.documentElement;
    el.setAttribute("data-nav", collapsed ? "rail" : "full");
    if (drawerOpen) el.setAttribute("data-drawer", "open");
    else el.removeAttribute("data-drawer");
  }, [collapsed, drawerOpen]);
  return null;
}

/** The only screens that render without a session. */
const PUBLIC_ROUTES = new Set(["/login", "/signup", "/privacy", "/terms"]);

const FocusContext = createContext<((on: boolean) => void) | null>(null);

/**
 * Claim the whole viewport while the calling component is mounted with
 * `active`: the header hides, exactly as it does on /review.
 *
 * A route cannot decide this on its own because /test/[id] is two screens —
 * the paper, which wants nothing around it, and the result afterwards, which
 * wants the nav back.
 */
export function useFocusMode(active: boolean) {
  const claim = useContext(FocusContext);
  useEffect(() => {
    if (!claim) return;
    claim(active);
    return () => claim(false);
  }, [claim, active]);
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <AppShellInner>{children}</AppShellInner>
    </ToastProvider>
  );
}

/** Everything below the toast layer, so the shell itself can raise toasts. */
function AppShellInner({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const toast = useToast();
  const [help, setHelp] = useState(false);
  const [claimed, setClaimed] = useState(false);
  const { mode, cycle } = useThemeMode();
  const { skin, toggle: toggleSkin } = useSkin();

  const pendingG = useRef(false);
  const gTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeNav = useRef<HTMLAnchorElement>(null);

  const closeHelp = useCallback(() => setHelp(false), []);

  /* --- the sidebar ------------------------------------------------------
     Two independent things, because they answer different questions.
     `collapsed` is a remembered preference on a wide screen — rail or
     labels. `navOpen` is transient: on a phone the sidebar is off-canvas,
     and this is whether it is currently pulled out. Every nav link closes
     it on click, so it never hangs over the page you just opened. */
  const { collapsed, toggle: toggleCollapsed } = useNavCollapsed();
  const [navOpen, setNavOpen] = useState(false);

  /* --- session ----------------------------------------------------------
     Every page here is a client component that fetches its own data, so the
     gate lives here rather than in Next middleware: one check, one place,
     no new machinery. `user` is fetched only while it is null, so ordinary
     navigation costs nothing — but the fetch does re-run after a login,
     which lands on "/" with the state still empty. */
  const isPublic = PUBLIC_ROUTES.has(pathname);
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    if (isPublic || user) return;
    let cancelled = false;
    // Not awaited, and deliberately started before the identity is known:
    // see lib/resources.ts. This is the difference between one round trip
    // and two before the first number lands.
    prefetchFor(pathname);
    getMe()
      .then((me) => {
        if (!cancelled) setUser(me);
      })
      .catch(() => {
        // A hard navigation, not router.replace: crossing an identity
        // boundary should drop every scrap of the previous session's client
        // state and RSC cache rather than carry it into the next one.
        if (!cancelled) window.location.replace("/login");
      });
    return () => {
      cancelled = true;
    };
  }, [isPublic, user, pathname]);

  const signOut = useCallback(async () => {
    try {
      await postLogout();
    } finally {
      window.location.replace("/login");
    }
  }, []);

  // The palette names theme states outright; the store only knows how to
  // cycle. Stepping the cycle the right number of times keeps the store —
  // and everything subscribed to it — honest.
  const setTheme = useCallback(
    (target: ThemeMode) => {
      const order: ThemeMode[] = ["system", "light", "dark"];
      let steps = (order.indexOf(target) - order.indexOf(mode) + 3) % 3;
      while (steps-- > 0) cycle();
    },
    [cycle, mode],
  );

  // Phosphor is committed-dark, so the light/dark actions vanish under it —
  // exactly as the header's theme control does. The skin switcher itself is
  // always on offer.
  const paletteActions = useMemo(() => {
    const base = buildDefaultActions({
      push: (href) => router.push(href),
      setTheme,
      toast,
    });
    const actions =
      skin === "phosphor" ? base.filter((a) => a.section !== "Theme") : base;
    const other = skin === "phosphor" ? "ember" : "phosphor";
    return [
      ...actions,
      {
        // Beside "Go to Test", because from the keyboard the two are the same
        // destination with a different test waiting on it.
        id: "nav-yash-made-test",
        title: "Yash Made Test",
        section: "Navigate",
        keywords: "mcq multiple choice bank curated quiz yash",
        perform: () => {
          setTestMode("yash");
          router.push("/test");
        },
      },
      {
        id: "skin-switch",
        title: `Switch skin — ${other}`,
        section: "Theme",
        keywords: "skin phosphor ember appearance design language look",
        perform: () => toggleSkin(),
      },
    ];
  }, [router, setTheme, toast, skin, toggleSkin]);

  // Six destinations do not fit across a phone, so the strip scrolls — and the
  // page you are on has to be the part of it you can see.
  useEffect(() => {
    activeNav.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pathname]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // While the overlay is open it owns the keyboard entirely, so a page's
      // own handlers cannot fire underneath it.
      if (help) {
        if (e.key === "Escape" || e.key === "?") {
          e.preventDefault();
          setHelp(false);
        }
        e.stopPropagation();
        return;
      }

      if (isTypingTarget(e) || hasModifier(e)) return;

      if (e.key === "?") {
        e.preventDefault();
        e.stopPropagation();
        setHelp(true);
        return;
      }

      if (pendingG.current) {
        const target = GOTO[e.key.toLowerCase()];
        pendingG.current = false;
        if (gTimer.current) clearTimeout(gTimer.current);
        if (target) {
          e.preventDefault();
          e.stopPropagation();
          router.push(target);
          return;
        }
      }

      if (e.key === "g") {
        pendingG.current = true;
        if (gTimer.current) clearTimeout(gTimer.current);
        gTimer.current = setTimeout(() => {
          pendingG.current = false;
        }, 900);
        return;
      }

      if (e.key === "\\") {
        e.preventDefault();
        e.stopPropagation();
        toggleCollapsed();
        return;
      }

      if (e.key === "t") {
        e.preventDefault();
        e.stopPropagation();
        // The binding survives every skin, but Phosphor is committed-dark:
        // under it the theme toggle is inert, so `t` deliberately does
        // nothing rather than silently cycling an invisible setting.
        if (skin === "ember") cycle();
      }
    }

    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [router, cycle, help, skin, toggleCollapsed]);

  // Focus mode: the review screen carries no chrome at all, and a paper in
  // progress claims the same treatment for as long as it is being sat.
  const focus = pathname === "/review" || claimed;

  // /login and /signup render themselves, with none of the shell around them.
  if (isPublic) {
    return (
      <>
        <div aria-hidden="true" className="grain" />
        {children}
      </>
    );
  }

  // Nothing gated paints before the session is known — a flash of someone
  // else's dashboard shape, however brief, is worse than a blank moment.
  if (!user) {
    return (
      <>
        <div aria-hidden="true" className="grain" />
        <div className="min-h-[100dvh] grid place-items-center">
          <p className="telemetry text-[11px] text-fg-3">signing in…</p>
        </div>
      </>
    );
  }

  return (
    <FocusContext.Provider value={setClaimed}>
      <div aria-hidden="true" className="grain" />
      <NavState collapsed={collapsed} drawerOpen={navOpen} />

      {!focus && (
        <>
          {/* The scrim only exists on small screens, where the sidebar
              overlays the page instead of sitting beside it. */}
          {navOpen && (
            <button
              aria-label="Close navigation"
              onClick={() => setNavOpen(false)}
              className="fixed inset-0 z-30 md:hidden"
              style={{ background: "var(--scrim)" }}
            />
          )}

          <aside
            aria-label="Main"
            className="nav-aside fixed inset-y-0 left-0 z-40 flex flex-col
              border-r border-line bg-surface"
          >
            <div className="h-11 flex items-center gap-2 px-3 border-b border-line">
              <Link
                href="/"
                onClick={() => setNavOpen(false)}
                className="text-[11px] font-bold tracking-[0.16em] text-fg
                  whitespace-nowrap overflow-hidden"
                title="Recall"
              >
                {collapsed ? "R" : "RECALL"}
              </Link>
              <button
                onClick={toggleCollapsed}
                aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                title={`${collapsed ? "Expand" : "Collapse"} sidebar (\\)`}
                className="ml-auto hidden md:grid place-items-center h-6 w-6 rounded-xs
                  text-fg-3 hover:text-fg hover:bg-surface-hover
                  transition-colors duration-[90ms]"
              >
                <span aria-hidden="true" className="text-[13px] leading-none">
                  {collapsed ? "›" : "‹"}
                </span>
              </button>
            </div>

            <nav className="flex-1 overflow-y-auto py-2">
              {NAV.map((item) => {
                const active =
                  item.href === "/"
                    ? pathname === "/"
                    : pathname.startsWith(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    ref={active ? activeNav : undefined}
                    aria-current={active ? "page" : undefined}
                    onClick={() => setNavOpen(false)}
                    title={collapsed ? item.label : undefined}
                    className={`relative flex items-center gap-2.5 h-9 px-3 mx-1.5 rounded-sm
                      text-[13px] whitespace-nowrap overflow-hidden
                      transition-colors duration-[90ms]
                      ${
                        active
                          ? "text-fg font-semibold bg-surface-hover"
                          : "text-fg-2 font-normal hover:text-fg hover:bg-surface-hover"
                      }`}
                  >
                    <span
                      aria-hidden="true"
                      className="shrink-0 w-1 h-4 rounded-full"
                      style={{
                        background: active ? "var(--accent)" : "transparent",
                      }}
                    />
                    <span className={collapsed ? "md:hidden" : ""}>
                      {item.label}
                    </span>
                  </Link>
                );
              })}
            </nav>

            <div className="border-t border-line p-1.5 flex flex-col gap-1">
              {MOCK && !collapsed && (
                <span
                  className="label border border-line rounded-xs px-1.5 py-px self-start"
                  title="Serving fixture data from lib/mock.ts"
                >
                  mock data
                </span>
              )}
              <div
                className={`flex items-center gap-1 ${
                  collapsed ? "md:flex-col" : ""
                }`}
              >
                <button
                  onClick={toggleSkin}
                  title={`Skin: ${skin}. Click for the next one.`}
                  aria-label={`Skin: ${skin}. Click to switch.`}
                  className="h-6 px-1.5 rounded-xs border border-transparent
                    hover:border-line text-[10px] font-medium tracking-[0.12em]
                    text-fg-3 hover:text-fg-2 transition-colors duration-[90ms]
                    overflow-hidden"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  {collapsed ? skin.slice(0, 1).toUpperCase() : skin.toUpperCase()}
                </button>
                {skin === "ember" && <ThemeToggle mode={mode} onCycle={cycle} />}
                {!collapsed && (
                  <button
                    onClick={() => setHelp(true)}
                    title="Keyboard shortcuts (?)"
                    aria-label="Keyboard shortcuts"
                    className="hidden sm:block"
                  >
                    <Kbd>?</Kbd>
                  </button>
                )}
              </div>
              <button
                onClick={signOut}
                title={`Signed in as ${user.name} — sign out`}
                aria-label={`Signed in as ${user.name}. Sign out.`}
                className="h-6 px-1.5 rounded-xs border border-transparent
                  hover:border-line text-[10px] font-medium tracking-[0.12em]
                  text-fg-3 hover:text-fg-2 transition-colors duration-[90ms]
                  text-left overflow-hidden"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                {collapsed ? "⏻" : `SIGN OUT · ${user.name}`}
              </button>
            </div>
          </aside>

          {/* The one control that has to exist on a phone, where the sidebar
              is off-canvas: something to pull it back. */}
          <button
            onClick={() => setNavOpen(true)}
            aria-label="Open navigation"
            className="md:hidden fixed top-2 left-2 z-20 h-8 w-8 grid place-items-center
              rounded-sm border border-line bg-surface text-fg-2
              hover:text-fg transition-colors duration-[90ms]"
          >
            <span aria-hidden="true" className="text-[14px] leading-none">≡</span>
          </button>
        </>
      )}

      <div
        // No transition on the padding: animating a layout property makes
        // the whole page reflow every frame, and the design system's motion
        // rule is paint-only. The sidebar slides; the content just moves.
        className={focus ? "" : "nav-content"}
      >
        {children}
      </div>

      {help && <ShortcutsOverlay onClose={closeHelp} />}

      <CommandPalette actions={paletteActions} />
    </FocusContext.Provider>
  );
}
