"use client";

import {
  type ButtonHTMLAttributes,
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Drawer } from "vaul";

// The modal from astrl.me: a centred dialog from 640 px, a vaul bottom drawer below that. Both
// trap focus and lock the page's scroll; they fade and scale (or slide) in 220 ms. Under reduced
// motion the dialog's animations take 1 ms rather than none, so `animationend` still closes it.

type ModalContextValue = {
  onClose: () => void;
  titleId: string;
  descriptionId: string;
  /** In the drawer the title is vaul's, which names the drawer for assistive tech. */
  drawer: boolean;
  /** A description registers itself, so `aria-describedby` never points at nothing. */
  setDescribed: (described: boolean) => void;
};
const ModalContext = createContext<ModalContextValue | null>(null);

function useModalContext(): ModalContextValue {
  const ctx = useContext(ModalContext);
  if (!ctx) throw new Error("Modal subcomponents must be used inside <Modal.Root>");
  return ctx;
}

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth < 640 : false,
  );
  useLayoutEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const sync = (e: MediaQueryListEvent | MediaQueryList) => setMobile(e.matches);
    sync(mq);
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return mobile;
}

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

function useFocusTrap<T extends HTMLElement>(ref: RefObject<T | null>, enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !ref.current) return;
    const el = ref.current;
    const prev = document.activeElement as HTMLElement;
    const focusable = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));
    focusable[0]?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    el.addEventListener("keydown", handler);
    return () => {
      el.removeEventListener("keydown", handler);
      prev?.focus(); // back where it was when the modal closes
    };
  }, [enabled, ref]);
}

function useScrollLock(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [enabled]);
}

const SCRIM = "fixed inset-0 z-50 bg-scrim/60 backdrop-blur-sm";

function ModalPortal({
  open,
  onClose,
  titleId,
  descriptionId,
  children,
  closeOnOverlayClick,
  closeOnEsc,
}: {
  open: boolean;
  onClose: () => void;
  titleId: string;
  descriptionId: string | undefined;
  children: ReactNode;
  closeOnOverlayClick: boolean;
  closeOnEsc: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(open);
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setVisible(true);
  }
  const closing = visible && !open;
  const handleBackdropAnimationEnd = useCallback(() => {
    if (!open) setVisible(false);
  }, [open]);

  useEffect(() => {
    if (!open || !closeOnEsc) return;
    const handler = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose, closeOnEsc]);
  useScrollLock(open);
  useFocusTrap(panelRef, open);

  if (!visible) return null;
  return createPortal(
    <>
      <div
        data-closing={closing ? "true" : undefined}
        onAnimationEnd={handleBackdropAnimationEnd}
        className={`${SCRIM} animate-[fadeIn_220ms_ease_forwards] data-closing:animate-[fadeOut_220ms_ease_forwards] motion-reduce:[animation-duration:1ms]`}
        aria-hidden="true"
        onClick={closeOnOverlayClick ? onClose : undefined}
      />
      <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center">
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          data-closing={closing ? "true" : undefined}
          tabIndex={-1}
          className="pointer-events-auto max-h-[calc(100dvh-2rem)] w-[min(448px,calc(100vw-2rem))] overflow-y-auto rounded-2xl border border-mist bg-surface p-6 text-ink shadow-2xl outline-none animate-[modalIn_220ms_cubic-bezier(0.16,1,0.3,1)_forwards] data-closing:animate-[modalOut_220ms_cubic-bezier(0.16,1,0.3,1)_forwards] motion-reduce:[animation-duration:1ms]"
        >
          {children}
        </div>
      </div>
    </>,
    document.body,
  );
}

function ModalRoot({
  open,
  onClose,
  children,
  closeOnOverlayClick = true,
  closeOnEsc = true,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  closeOnOverlayClick?: boolean;
  closeOnEsc?: boolean;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const [described, setDescribed] = useState(false);
  const isMobile = useIsMobile();
  // What was shown stays while the modal animates closed.
  const [snapshot, setSnapshot] = useState<ReactNode>(children);
  if (open && snapshot !== children) setSnapshot(children);
  const stableChildren = open ? children : snapshot;
  const ctx: ModalContextValue = {
    onClose,
    titleId,
    descriptionId,
    drawer: isMobile,
    setDescribed,
  };
  const describedBy = described ? descriptionId : undefined;

  if (isMobile) {
    return (
      <ModalContext.Provider value={ctx}>
        <Drawer.Root
          open={open}
          onOpenChange={(o) => !o && onClose()}
          dismissible={closeOnOverlayClick}
        >
          <Drawer.Portal>
            <Drawer.Overlay className={SCRIM} />
            <Drawer.Content
              aria-labelledby={titleId}
              aria-describedby={describedBy}
              className="fixed right-0 bottom-0 left-0 z-50 flex h-auto max-h-[96%] flex-col overflow-y-auto rounded-t-3xl border-mist border-t bg-surface px-6 pt-4 pb-10 text-ink outline-none"
            >
              <Drawer.Handle className="mx-auto mb-5 h-1 w-10 rounded-full bg-ash" />
              {stableChildren}
            </Drawer.Content>
          </Drawer.Portal>
        </Drawer.Root>
      </ModalContext.Provider>
    );
  }
  return (
    <ModalContext.Provider value={ctx}>
      <ModalPortal
        open={open}
        onClose={onClose}
        titleId={titleId}
        descriptionId={describedBy}
        closeOnOverlayClick={closeOnOverlayClick}
        closeOnEsc={closeOnEsc}
      >
        {stableChildren}
      </ModalPortal>
    </ModalContext.Provider>
  );
}

function ModalTitle({ children, className = "" }: { children: ReactNode; className?: string }) {
  const { titleId, drawer } = useModalContext();
  const style = `font-semibold text-[19px] leading-[1.35] ${className}`;
  return drawer ? (
    <Drawer.Title id={titleId} className={style}>
      {children}
    </Drawer.Title>
  ) : (
    <h2 id={titleId} className={style}>
      {children}
    </h2>
  );
}

function ModalDescription({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  const { descriptionId, setDescribed } = useModalContext();
  useEffect(() => {
    setDescribed(true);
    return () => setDescribed(false);
  }, [setDescribed]);
  return (
    <p id={descriptionId} className={`mt-2 text-[16px] leading-[1.55] ${className}`}>
      {children}
    </p>
  );
}

function ModalClose({
  children,
  className = "",
  onClick,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) {
  const { onClose } = useModalContext();
  return (
    <button
      type="button"
      className={className}
      aria-label="Close dialog"
      onClick={(e) => {
        onClose();
        onClick?.(e);
      }}
      {...rest}
    >
      {children}
    </button>
  );
}

export const Modal = {
  Root: ModalRoot,
  Title: ModalTitle,
  Description: ModalDescription,
  Close: ModalClose,
} as const;
