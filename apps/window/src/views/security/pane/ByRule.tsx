// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { SecurityRuleRow, SecurityTick, SecurityWords } from "@spi-code/contracts";
import { type CSSProperties, type KeyboardEvent, useState } from "react";
import { OpenedRule } from "./OpenedRule.js";
import { RULE_ATTR, type SectionProps } from "./state.js";
import { Words, wordsText } from "./Words.js";
import "./ByRule.css";

interface Hot {
  key: string;
  repository: string;
}

const COUNT_BAR_PX = 92;
const TICK_MIN_PX = 4;
const TICK_RANGE_PX = 14;

const heavy = (rule: SecurityRuleRow) => rule.worst === "critical" || rule.worst === "high";
const weight = (tick: SecurityTick) =>
  tick.high === tick.alerts ? "heavy" : tick.high > 0 ? "mixed" : "light";
const steps = (rule: SecurityRuleRow) => rule.ticks.filter((tick) => tick.alerts > 0 || !tick.read);

/** A scanner's title, with its backticked words drawn as code. */
function Title({ title }: { title: string }) {
  return title.split("`").map((part, index) =>
    // biome-ignore lint/suspicious/noArrayIndexKey: a title's parts never reorder.
    index % 2 ? <code key={index}>{part}</code> : part,
  );
}

/** The fix, the age and the fix PRs, in that order; the first present one leads. */
function FixLines({ rule }: { rule: SecurityRuleRow }) {
  const lines = [rule.fix, rule.age, rule.prs].filter((words) => words.length > 0);
  return lines.map((words, index) => (
    <span key={wordsText(words)} data-lead={index === 0 || undefined}>
      <Words words={words} />
    </span>
  ));
}

function Strip({
  rule,
  tickMax,
  program,
  hot,
  setHot,
  open,
}: {
  rule: SecurityRuleRow;
  tickMax: number;
  program: string | undefined;
  hot: Hot | null;
  setHot: (hot: Hot | null) => void;
  open: (mark?: string) => void;
}) {
  const here =
    hot?.key === rule.key ? rule.ticks.find((t) => t.repository === hot.repository) : undefined;
  const caption: SecurityWords = here ? here.name : rule.spread;
  const point = (tick: SecurityTick | undefined) =>
    setHot(tick ? { key: rule.key, repository: tick.repository } : null);
  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    const ticks = steps(rule);
    const at = here ? ticks.indexOf(here) : -1;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const step = event.key === "ArrowRight" ? 1 : -1;
      const next =
        at < 0
          ? step > 0
            ? 0
            : ticks.length - 1
          : Math.max(0, Math.min(ticks.length - 1, at + step));
      point(ticks[next]);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open(at >= 0 ? here?.repository : undefined);
    }
  };
  return (
    <span className="security-rule-spread">
      {/* biome-ignore lint/a11y/useSemanticElements: a strip of ticks, not form controls a fieldset would group */}
      <span
        className="security-strip"
        role="group"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: one focus stop whose arrow keys walk its ticks
        tabIndex={0}
        aria-label={wordsText(rule.strip)}
        style={{ "--n": rule.ticks.length } as CSSProperties}
        onKeyDown={onKeyDown}
        onBlur={() => point(undefined)}
        onMouseLeave={() => point(undefined)}
        onClick={(event) => event.stopPropagation()}
      >
        {rule.ticks.map((tick) => {
          const active = tick.alerts > 0 || !tick.read;
          const style = {
            "--h": `${Math.round(TICK_MIN_PX + TICK_RANGE_PX * Math.sqrt(tick.alerts / Math.max(1, tickMax)))}px`,
            "--hi": `${tick.alerts ? (tick.high / tick.alerts) * 100 : 0}%`,
          } as CSSProperties;
          return (
            <i
              key={tick.repository}
              aria-hidden="true"
              title={wordsText(tick.name)}
              data-weight={tick.read && tick.alerts > 0 ? weight(tick) : undefined}
              data-unread={tick.read ? undefined : ""}
              data-gap={tick.repository === program || undefined}
              data-hot={hot?.repository === tick.repository || undefined}
              style={tick.alerts > 0 ? style : undefined}
              onMouseEnter={() => point(active ? tick : undefined)}
              onClick={active ? () => open(tick.repository) : undefined}
            />
          );
        })}
      </span>
      <small aria-live="polite" data-hot={here ? "" : undefined}>
        <Words words={caption} />
      </small>
    </span>
  );
}

function CountBar({ rule, barMax }: { rule: SecurityRuleRow; barMax: number }) {
  const scale = COUNT_BAR_PX / Math.max(1, barMax);
  const lower = rule.alerts.n - rule.high;
  return (
    <span className="security-rule-count">
      <span className="security-count-bar" aria-hidden="true">
        {rule.high > 0 && (
          <span data-part="high" style={{ width: Math.max(2, rule.high * scale) }} />
        )}
        {lower > 0 && <span data-part="lower" style={{ width: Math.max(2, lower * scale) }} />}
      </span>
      <b>
        <Words words={[rule.alerts]} />
      </b>
    </span>
  );
}

/** The chosen lane by rule; an opened row draws OpenedRule inside it. */
export function ByRule(props: SectionProps) {
  const { pane, lane, state, actions } = props;
  const [hot, setHot] = useState<Hot | null>(null);
  const { columns, heading, rules, tickMax, barMax } = lane.byRule;
  if (rules.length === 0) return null;
  const program = pane.repositories.find((repository) => repository.program)?.name;
  return (
    <div className="security-rules" data-lane={lane.id}>
      <div className="security-rule-grid security-rules-head">
        <span>{columns.worst}</span>
        <span>{columns.rule}</span>
        <span data-column="spread">
          <Words words={heading} />
        </span>
        <span>{columns.alerts}</span>
        <span data-column="fix">{columns.fix}</span>
      </div>
      {rules.map((rule) => {
        const open = state.rule === rule.key;
        const toggle = () => actions.openRule(open ? null : rule.key);
        return (
          <div
            key={rule.key}
            className="security-rule"
            {...{ [RULE_ATTR]: rule.key }}
            data-open={open || undefined}
          >
            {/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: the title button is the row's keyboard control. */}
            <div className="security-rule-grid security-rule-head" onClick={toggle}>
              <span className="security-rule-worst" data-heavy={heavy(rule) || undefined}>
                {rule.severity}
              </span>
              <span className="security-rule-what">
                <button
                  type="button"
                  className="security-rule-title"
                  aria-expanded={open}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggle();
                  }}
                >
                  <Title title={rule.title} />
                </button>
                <span className="security-rule-sub">
                  <Words words={rule.sub} />
                  <span className="security-rule-spreadword">
                    <Words words={rule.spread} />
                  </span>
                </span>
                <span className="security-rule-narrowfix">
                  <FixLines rule={rule} />
                </span>
              </span>
              <Strip
                rule={rule}
                tickMax={tickMax}
                program={program}
                hot={hot}
                setHot={setHot}
                open={(mark) => actions.openRule(rule.key, mark)}
              />
              <CountBar rule={rule} barMax={barMax} />
              <span className="security-rule-fix">
                <FixLines rule={rule} />
              </span>
            </div>
            {open && <OpenedRule {...props} rule={rule} />}
          </div>
        );
      })}
    </div>
  );
}
