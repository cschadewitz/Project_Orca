/**
 * `@orca/agents/review-judge`: what the daemon and CLI need from the plain-rule review judge (#701), kept off the
 * general `@orca/agents` barrel so that importing agents never pulls the inactive judge in. Nothing exported here
 * turns a judge on.
 */
export {
  plainRuleDisclosureQuery,
  type PlainRuleDisclosureGrant,
  type PlainRuleDisclosureQuery,
  type PlainRuleDisclosureService,
} from "./plain-rule-connection.js";
export { JUDGE_DISCLOSURE_PURPOSE } from "./connection.js";
export { PLAIN_RULE_REQUEST_SCHEMA } from "./plain-rule.js";
