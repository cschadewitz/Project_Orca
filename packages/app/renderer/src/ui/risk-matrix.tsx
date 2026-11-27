/**
 * `RiskMatrix` — the plan's likelihood × impact grid over `.orca-risk` (#172).
 *
 * The grid is the plan's, not the design sketch's 5×5: `riskMatrix.scale` runs 2..10 and the
 * three thresholds that cut it into levels are the plan's own (`RiskMatrixView`). So nothing
 * here knows a size or a band boundary. A cell's band is derived from its score against the
 * thresholds, the same arithmetic `core`'s `riskLevel` does, and the four core levels land on
 * the design system's four grounds — `critical` on `risk-severe`, the hatched one, so the top
 * band still separates in greyscale (rule 4).
 *
 * Three decisions worth knowing:
 *
 * - **Rows are likelihood, highest at the top; columns are impact, lowest at the left.** The
 *   worst corner is the top right, which is where a person looks for it.
 * - **The appetite line is an outline, not a colour.** Every cell whose level is above the
 *   plan's `riskAppetite` takes `.orca-risk__appetite`, so the edge of that region *is* the
 *   line, and the legend under the grid says what it means in words.
 * - **Every risk is labelled in place, never in a tooltip.** A pin is a button carrying the
 *   key in mono and the title in sans (rule 8); its accessible name adds the level and the
 *   two ratings, so the cell's colour is never the only thing saying how bad it is.
 */
import type { JSX } from "react";
import type { RiskMatrixView, RiskView } from "@orca/protocol";
import { textClass } from "./text.js";

export type RiskLevel = RiskView["level"];

/** The four core levels, lowest first — `RISK_LEVELS` in `core`, which the renderer may not import. */
export const RISK_LEVELS: readonly RiskLevel[] = ["low", "medium", "high", "critical"];

/** The design system's four grounds, by the core level each one draws. */
export const RISK_BAND: Record<RiskLevel, "low" | "moderate" | "high" | "severe"> = {
  low: "low",
  medium: "moderate",
  high: "high",
  critical: "severe",
};

/** Where a score sits on the plan's matrix. `core`'s `riskLevel`, restated because it cannot be imported. */
export function riskLevelOf(score: number, thresholds: RiskMatrixView["thresholds"]): RiskLevel {
  if (score >= thresholds.critical) return "critical";
  if (score >= thresholds.high) return "high";
  if (score >= thresholds.medium) return "medium";
  return "low";
}

/** Whether a level is above the plan's appetite, which is what holds an item. */
export const overAppetite = (level: RiskLevel, appetite: RiskLevel): boolean =>
  RISK_LEVELS.indexOf(level) > RISK_LEVELS.indexOf(appetite);

/** One risk as the grid places it. The wire's names: `key`, `title`. */
export interface RiskPin {
  id: string;
  key: string;
  title: string;
  likelihood: number;
  impact: number;
}

export interface RiskMatrixProps {
  /** `riskMatrix.scale` — the grid is `scale` × `scale`, 2..10. */
  scale: number;
  thresholds: RiskMatrixView["thresholds"];
  /** The plan's `policy.riskAppetite`; cells above it are outlined as over appetite. */
  appetite: RiskLevel;
  risks: readonly RiskPin[];
  selected?: string | undefined;
  onSelect: (riskId: string) => void;
}

/** `1..n`, as an array to map over. */
const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);

export function RiskMatrix({ scale, thresholds, appetite, risks, selected, onSelect }: RiskMatrixProps): JSX.Element {
  const byCell = new Map<string, RiskPin[]>();
  for (const risk of risks) {
    const at = `${risk.likelihood}:${risk.impact}`;
    const list = byCell.get(at);
    if (list) list.push(risk);
    else byCell.set(at, [risk]);
  }
  const impacts = range(scale);
  const likelihoods = range(scale).reverse();

  return (
    <table className="orca-risk" aria-label="Risk matrix, likelihood by impact">
      <thead>
        <tr>
          <th className={`orca-risk__rowhead ${textClass("caption")}`} scope="col">
            Likelihood
          </th>
          {impacts.map((impact) => (
            <th key={impact} className={textClass("caption")} scope="col">
              {`Impact ${impact}`}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {likelihoods.map((likelihood) => (
          <tr key={likelihood}>
            <th className={`orca-risk__rowhead ${textClass("caption")}`} scope="row">
              {likelihood}
            </th>
            {impacts.map((impact) => {
              const score = likelihood * impact;
              const level = riskLevelOf(score, thresholds);
              const classes = [`orca-risk__cell--${RISK_BAND[level]}`];
              if (overAppetite(level, appetite)) classes.push("orca-risk__appetite");
              return (
                <td key={impact} className={classes.join(" ")} data-level={level}>
                  <span className={`orca-risk__score ${textClass("mono-id")}`} aria-hidden="true">
                    {score}
                  </span>
                  {(byCell.get(`${likelihood}:${impact}`) ?? []).map((risk) => (
                    <button
                      key={risk.id}
                      type="button"
                      className={`orca-risk__pin ${textClass("caption")}`}
                      aria-pressed={risk.id === selected}
                      title={`${risk.key} ${risk.title}`}
                      aria-label={`${risk.key}, ${risk.title}, ${level}, likelihood ${likelihood}, impact ${impact}`}
                      onClick={() => onSelect(risk.id)}
                    >
                      <span className={textClass("mono-id")}>{risk.key}</span> <span>{risk.title}</span>
                    </button>
                  ))}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
