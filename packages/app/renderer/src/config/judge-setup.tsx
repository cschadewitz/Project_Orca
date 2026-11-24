/**
 * The judge setup checklist (#701) on the Config surface: what is in place for plain-language
 * rules to be judged, and the owner command for each step that is not. Read-only; offered only
 * when the daemon lists `judge.status`, and read again when the connection changes.
 */
import { useEffect, useState, type JSX } from "react";
import { JUDGE_STATUS_METHOD, type JudgeStatusResult } from "@orca/protocol";
import { useMethodPresent } from "../chrome/use-connection.js";
import { Chip, Text, textClass } from "../ui/index.js";
import { PLAIN_RULES_ACTIVE, PLAIN_RULES_INACTIVE_NOTE } from "./config-model.js";
import { judgeSetupSteps, type JudgeStepState } from "./judge-setup-model.js";

const MARK: Record<JudgeStepState, string> = { done: "Done", todo: "To do", blocked: "Not possible here" };

export function JudgeSetup(): JSX.Element | null {
  const offered = useMethodPresent(JUDGE_STATUS_METHOD);
  const [status, setStatus] = useState<JudgeStatusResult | undefined>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const read = window.orca.config.judgeStatus;
    if (!offered || !read) return;
    let current = true;
    const load = () =>
      void read().then((result) => {
        if (!current) return;
        if (result.ok) {
          setStatus(result.result);
          setFailed(false);
        } else setFailed(true);
      });
    load();
    const unsubscribe = window.orca.daemonConnection?.subscribe(load);
    return () => {
      current = false;
      unsubscribe?.();
    };
  }, [offered]);
  if (!offered || !window.orca.config.judgeStatus) return null;
  return (
    <section className="orca-config__section" aria-label="Plain-language rule judge">
      <div className="orca-config__layer-head">
        <Text style="heading" as="h2">
          Plain-language rule judge
        </Text>
        {!(status?.active ?? PLAIN_RULES_ACTIVE) && <Chip>inactive</Chip>}
      </div>
      {!(status?.active ?? PLAIN_RULES_ACTIVE) && (
        <Text style="caption" data-plain-rules-inactive="">
          {PLAIN_RULES_INACTIVE_NOTE}
        </Text>
      )}
      <Text style="caption">
        What has to be in place before a judge on your own key decides plain-language rules. Each step is yours: ORCA
        does not set your key, grant a disclosure or create the budget for you.
      </Text>
      {status === undefined ? (
        <Text style="caption" className="orca-config__none">
          {failed ? "The judge's setup could not be read." : "Reading the judge's setup…"}
        </Text>
      ) : (
        <ol className="orca-config__rules" aria-label="Judge setup steps">
          {judgeSetupSteps(status).map((step) => (
            <li key={step.id} className="orca-config__rule" data-judge-step={step.id} data-state={step.state}>
              <Text style="label-strong">{step.title}</Text>
              <Chip>{MARK[step.state]}</Chip>
              <Text style="caption">{step.detail}</Text>
              {step.command !== undefined && (
                <span className={`orca-config__path ${textClass("mono-id")}`} data-judge-command="">
                  {step.command}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
