/** Focus ownership for Plan's inline questions, following ClaimRow and DraftBar. */
import { useId, useLayoutEffect, useRef, useState, type JSX, type ReactNode } from "react";
import { Button, type ButtonProps } from "../ui/button.js";
import { useTransientLayer } from "../layers-context.js";

export function useInlineConfirmation() {
  const [question, setQuestion] = useState<object | undefined>(undefined);
  const current = useRef<object | undefined>(undefined);
  const generation = useRef<object | undefined>(undefined);
  const restore = useRef(false);
  const mounted = useRef(false);
  const triggerId = useId();

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      current.current = undefined;
    };
  }, []);

  const isCurrent = (owner: object): boolean => mounted.current && current.current === owner;
  const close = (owner: object, returnToTrigger: boolean): boolean => {
    if (!isCurrent(owner)) return false;
    restore.current = returnToTrigger;
    current.current = undefined;
    setQuestion(undefined);
    return true;
  };

  const cancel = (): void => {
    if (question) close(question, true);
  };
  useTransientLayer(question !== undefined, { name: "plan-confirm", close: cancel });

  return {
    question,
    triggerId,
    isMounted: () => mounted.current,
    isAsking: () => current.current !== undefined,
    arm: () => {
      const owner = {};
      restore.current = false;
      generation.current = current.current = owner;
      setQuestion(owner);
    },
    cancel,
    close,
    // Read after the commit: cancellation/refusal restores only this mounted target's
    // trigger. Success or withdrawal uses the containing inspector, if it survived.
    returnFocus: (owner: object, region: HTMLElement | null): void => {
      if (generation.current !== owner) return;
      const target = restore.current && mounted.current ? document.getElementById(triggerId) : region;
      if (target?.isConnected) target.focus();
    },
  };
}

export function InlineConfirmation({
  confirmation,
  label,
  children,
}: {
  confirmation: ReturnType<typeof useInlineConfirmation>;
  label: string;
  children: ReactNode;
}): JSX.Element {
  const group = useRef<HTMLDivElement>(null);
  const latest = useRef(confirmation);
  latest.current = confirmation;

  useLayoutEffect(() => {
    const element = group.current;
    const owner = latest.current.question!;
    element?.querySelector<HTMLElement>("[data-plan-confirm-keep]")?.focus();
    return () => {
      if (!element?.contains(document.activeElement)) return;
      const region = element.closest<HTMLElement>(".orca-plan__inspector");
      // As in DraftBar: wait for replacement controls, and leave any focus claimed by
      // another control during this commit alone. A later arming invalidates this move.
      queueMicrotask(() => {
        const active = document.activeElement;
        if (active !== null && active !== document.body) return;
        latest.current.returnFocus(owner, region);
      });
    };
  }, []);

  return (
    <div ref={group} className="orca-plan__confirm" role="group" aria-label={label}>
      {children}
    </div>
  );
}

/** Preserve the containing inspector when a resting trigger is removed by a pushed update.
 * On arming, the question claims focus in the same commit and this fallback stays silent. */
export function InlineConfirmationTrigger({
  confirmation,
  ...props
}: ButtonProps & { confirmation: ReturnType<typeof useInlineConfirmation> }): JSX.Element {
  const latest = useRef(confirmation);
  latest.current = confirmation;
  const id = confirmation.triggerId;
  useLayoutEffect(() => {
    const element = document.getElementById(id);
    return () => {
      if (element !== document.activeElement || latest.current.isAsking()) return;
      const region = element?.closest<HTMLElement>(".orca-plan__inspector");
      queueMicrotask(() => {
        if (latest.current.isAsking()) return;
        if (document.activeElement === document.body && region?.isConnected) region.focus();
      });
    };
  }, [id]);
  return <Button {...props} id={id} onClick={confirmation.arm} />;
}
