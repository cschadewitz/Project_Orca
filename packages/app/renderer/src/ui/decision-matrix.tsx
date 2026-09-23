/**
 * `DecisionMatrix` — a weighted decision matrix over `.orca-table.orca-matrix` (#173).
 *
 * Criteria are rows, with their weight and whether lower is better; options are columns,
 * with the score each one was given; the last row is each option's weighted total as the
 * matrix ranked it. The recommended column is marked `.orca-matrix__win` — the accent
 * ground and an accent outline, because its header is a control (rule 5: accent means
 * interactive) and deciding is an act.
 *
 * It computes nothing. The totals and the recommendation come in as `result`, which is
 * `core`'s arithmetic, stored or previewed by the daemon; a matrix with no result draws the
 * scores and says it has no ranking rather than inventing one (rule 12).
 *
 * The column headers are the decide controls when `onChoose` is given: one button per option,
 * named for the act ("Decide Redis"). A decided matrix passes no `onChoose` and the headers
 * are words again, with the chosen column named as such.
 */
import type { JSX } from "react";
import type { DecisionView } from "@orca/protocol";
import { Button } from "./button.js";
import { textClass } from "./text.js";

export interface DecisionMatrixProps {
  /** The wire's criteria: `key`, `name`, `weight`, `direction`. */
  criteria: DecisionView["criteria"];
  /** The wire's options: `key`, `name`, `scores` by criterion key. */
  options: DecisionView["options"];
  /** Scores run 0..`scale`. */
  scale: number;
  result?: DecisionView["result"] | undefined;
  /** The option somebody chose, once the decision is decided. */
  chosen?: string | undefined;
  /** Given while the decision is open: a column header decides for its option. */
  onChoose?: ((option: string) => void) | undefined;
  /** Why the headers cannot decide right now (`useWritability`'s sentence). */
  disabledReason?: string | undefined;
  label: string;
}

export function DecisionMatrix({
  criteria,
  options,
  scale,
  result,
  chosen,
  onChoose,
  disabledReason,
  label,
}: DecisionMatrixProps): JSX.Element {
  const recommended = result?.recommended;
  const win = (option: string): string => (option === recommended ? "orca-matrix__win" : "");
  const total = (option: string): number | undefined => result?.ranking.find((entry) => entry.option === option)?.score;

  return (
    <table className={`orca-table orca-matrix ${textClass("label")}`} aria-label={label}>
      <thead>
        <tr>
          <th className={textClass("caption")} scope="col">
            Criterion
          </th>
          <th className={`orca-table__num ${textClass("caption")}`} scope="col">
            Weight
          </th>
          {options.map((option) => (
            <th key={option.key} className={`${win(option.key)} ${textClass("caption")}`} scope="col">
              {onChoose === undefined ? (
                <span>
                  {option.name}
                  {option.key === chosen ? " — chosen" : ""}
                </span>
              ) : (
                <Button
                  size="sm"
                  tone={option.key === recommended ? "primary" : "ghost"}
                  disabled={disabledReason !== undefined}
                  {...(disabledReason === undefined ? {} : { disabledReason })}
                  onClick={() => onChoose(option.key)}
                >
                  {`Decide ${option.name}`}
                </Button>
              )}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {criteria.map((criterion) => (
          <tr key={criterion.key}>
            <th scope="row" className={textClass("label")}>
              {criterion.name}
              {criterion.direction === "minimize" ? (
                <span className={`orca-matrix__w ${textClass("mono-id")}`}> lower is better</span>
              ) : null}
            </th>
            <td className={`orca-table__num orca-matrix__w ${textClass("mono-id")}`}>{`w${criterion.weight}`}</td>
            {options.map((option) => {
              const score = option.scores[criterion.key];
              return (
                <td key={option.key} className={`orca-table__num ${win(option.key)} ${textClass("mono-id")}`}>
                  <span className="orca-matrix__score">{score === undefined ? "—" : `${score}/${scale}`}</span>
                </td>
              );
            })}
          </tr>
        ))}
        <tr>
          <th scope="row" className={textClass("label-strong")}>
            Weighted total
          </th>
          <td />
          {options.map((option) => {
            const value = total(option.key);
            return (
              <td key={option.key} className={`orca-table__num ${win(option.key)} ${textClass("mono-id")}`}>
                {value === undefined ? "—" : value.toFixed(2)}
              </td>
            );
          })}
        </tr>
      </tbody>
    </table>
  );
}
