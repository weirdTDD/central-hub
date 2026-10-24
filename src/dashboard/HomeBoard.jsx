// The dashboard home, laid out like a course screen.
//
// A bar is a share of this week's recorded learning, not how much of a course
// is finished. A week dot fills only when that day has recorded time. The
// number on the dark card counts consecutive active days inside this week.

import { createElement, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { BookOpen, ChevronRight, Code2, ListTodo, Zap } from "lucide-react";
import { avatarFor } from "../lib/avatar";
import { isSupabaseConfigured } from "../lib/supabase";
import { listCodingObservations, listLearningObservations } from "../lib/tracking";
import {
  coveredSeconds,
  groupedCoveredSeconds,
  heartbeatsFromRows as learningFromRows,
} from "../../extensions/learning-tracker/lib/learningTime.js";
import {
  coveredSeconds as codingCovered,
  groupedCoveredSeconds as codingGrouped,
  heartbeatsFromRows as codingFromRows,
} from "../../extensions/coding-tracker/lib/codingTime.js";
import { sharePercent } from "../features/progress/scale.js";
import { localDayRange } from "../features/coding/range.js";
import { localDayKey } from "../lib/dates.js";
import { durationText, estimateText, formatDayHeading, greetingFor, personName } from "./todayView";
import { activeDayKeys, streakInWeek } from "./homeBoard.js";

export default function HomeBoard({
  user,
  dayKey,
  today,
  timeZone,
  days = [],
  onSelectDay,
  plan = [],
  planState = "unconfigured",
  sessionDayKeys = [],
}) {
  const name = personName(user);
  const heading = name ? `Hey, ${name.split(" ")[0]}` : greetingFor(new Date(), timeZone);
  const weekFrom = days[0] ? localDayRange(days[0].key, timeZone)?.from : null;
  const weekTo = days.length ? localDayRange(days[days.length - 1].key, timeZone)?.to : null;
  const requestKey = `${weekFrom ?? ""}|${weekTo ?? ""}|${timeZone}`;
  const [seenKey, setSeenKey] = useState(requestKey);
  const [state, setState] = useState(isSupabaseConfigured ? "loading" : "unconfigured");
  const [learning, setLearning] = useState([]);
  const [coding, setCoding] = useState([]);
  const [error, setError] = useState("");
  const [truncated, setTruncated] = useState(false);

  if (seenKey !== requestKey) {
    setSeenKey(requestKey);
    setState(isSupabaseConfigured ? "loading" : "unconfigured");
    setLearning([]);
    setCoding([]);
    setError("");
    setTruncated(false);
  }

  useEffect(() => {
    if (!isSupabaseConfigured || !weekFrom || !weekTo) return undefined;
    let active = true;
    Promise.all([
      listLearningObservations({ from: weekFrom, to: weekTo, limit: 1000 }),
      listCodingObservations({ from: weekFrom, to: weekTo, limit: 1000 }),
    ])
      .then(([learned, coded]) => {
        if (!active) return;
        setLearning(learningFromRows(learned.rows));
        setCoding(codingFromRows(coded.rows));
        setTruncated(Boolean(learned.truncated || coded.truncated));
        setState("ready");
      })
      .catch((caught) => {
        if (!active) return;
        setLearning([]);
        setCoding([]);
        setState("error");
        setError(caught?.message || "Could not load this week.");
      });
    return () => {
      active = false;
    };
  }, [weekFrom, weekTo]);

  const courses = useMemo(
    () =>
      groupedCoveredSeconds(learning, (beat) =>
        beat.courseLabel
          ? `${beat.siteLabel || beat.siteHost} · ${beat.courseLabel}`
          : beat.siteLabel || beat.siteHost || "Learning"
      ).sort((a, b) => (b.activeSeconds ?? -1) - (a.activeSeconds ?? -1)),
    [learning]
  );
  const weekLearning = coveredSeconds(learning);
  const featured = courses[0] ?? null;
  const featuredShare = sharePercent(featured?.activeSeconds, weekLearning);
  const projects = useMemo(
    () =>
      codingGrouped(
        coding.filter((beat) => localDayOf(beat, timeZone) === dayKey),
        (beat) => beat.projectName || "No project"
      ).sort((a, b) => (b.activeSeconds ?? -1) - (a.activeSeconds ?? -1)),
    [coding, dayKey, timeZone]
  );
  const codingTotal = codingCovered(coding.filter((beat) => localDayOf(beat, timeZone) === dayKey));
  const active = useMemo(
    () => activeDayKeys({ learning, coding, sessionDayKeys, timeZone }),
    [learning, coding, sessionDayKeys, timeZone]
  );
  const streak = streakInWeek(days, active, today);
  const streakKnown = state === "ready";
  const activeThisWeek = days.filter((day) => active.has(day.key)).length;
  const nextTask = plan.find((task) => task.isNext) ?? plan.find((task) => task.status !== "completed" && task.status !== "cancelled") ?? null;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <img src={avatarFor(user)} alt="" className="h-12 w-12 rounded-full" />
          <div>
            <h1 className="text-xl font-serif font-bold tracking-tight">{heading}</h1>
            <p className="mt-0.5 text-base text-muted-foreground">
              {featured
                ? `Latest course: ${featured.key}`
                : `${formatDayHeading(dayKey) || "Today"}. Recorded time shows up here.`}
            </p>
          </div>
        </div>
          <div className="flex flex-wrap gap-2">
            <Link
              to="/reports"
              className="inline-flex min-h-9 items-center rounded-lg border border-border bg-card px-3 text-base font-semibold shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Review
            </Link>
            <Link
              to="/learning"
              className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-border bg-card-sky px-3 text-base font-semibold shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Zap className="h-3 w-3" aria-hidden="true" />
              Day streak
              {streakKnown ? (
                <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-foreground px-1 text-xs font-bold text-background">
                  {streak}
                </span>
              ) : null}
            </Link>
          </div>
      </header>

      <div className="@container">
      <div className="grid items-stretch gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_240px]">
        <TrackCard
          eyebrow="Learn"
          icon={BookOpen}
          title={featured?.key || (state === "ready" ? "No course recorded" : statusTitle(state))}
          detail={
            state === "error"
              ? error
              : featured
                ? `${durationText(featured.activeSeconds)} this week`
                : state === "ready"
                  ? "Time on a tracked site will show here."
                  : statusDetail(state)
          }
          share={featuredShare}
          shareLabel={featuredShare != null ? `${featuredShare}% of this week` : null}
          href="/learning"
          tone="learn"
        />

        <div className="flex flex-col gap-3">
            <TrackCard
            eyebrow="Plan"
            icon={ListTodo}
            title={
              planState === "ready"
                ? nextTask?.title || "Nothing due"
                : statusTitle(planState)
            }
            detail={
              planState === "ready"
                ? nextTask
                  ? estimateText(nextTask.estimatedSeconds)
                  : "No open task is due this day."
                : statusDetail(planState)
            }
            href="/tasks"
            tone="plan"
          />
          <TrackCard
            eyebrow="Code"
            icon={Code2}
            title={projects[0]?.key || (state === "ready" ? "No coding recorded" : statusTitle(state))}
            detail={
              state === "ready"
                ? codingTotal != null
                  ? `${durationText(codingTotal)} today`
                  : "No editor time on this day."
                : statusDetail(state)
            }
            href="/coding"
            tone="code"
          />
        </div>
        
        <StreakCard
          days={days}
          selectedKey={dayKey}
          today={today}
          active={active}
          streak={streak}
          activeThisWeek={activeThisWeek}
          known={streakKnown}
          state={state}
          onSelectDay={onSelectDay}
        />
      </div>
      </div>

      <section aria-labelledby="continue-heading" className="rounded-xl border border-border bg-card-mist shadow-sm">
        <div className="flex items-center justify-between gap-2 px-3 py-3 sm:px-4">
          <h2 id="continue-heading" className="flex items-center gap-2 text-lg font-semibold">
            <span aria-hidden="true">↗</span>
            Pick up where you left off
          </h2>
          <Link
            to="/learning"
            className="inline-flex min-h-9 items-center text-base font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            See all
          </Link>
        </div>
        {truncated ? (
          <p className="px-3 pb-1 text-xs text-muted-foreground">
            This week has more heartbeats than were loaded, so the bars cover the loaded ones.
          </p>
        ) : null}
        {state === "error" ? (
          <p role="alert" className="px-3 pb-2 text-base text-destructive">{error}</p>
        ) : null}
        {state === "unconfigured" && courses.length === 0 ? (
          <p className="px-3 pb-2 text-base text-muted-foreground">Not connected. Configure Supabase to load courses.</p>
        ) : null}
        {courses.length === 0 && planState === "ready" && plan.length === 0 && state !== "loading" ? (
          <p className="px-3 pb-2 text-base text-muted-foreground">
            Nothing to pick up yet. A tracked learning site, a coding session, or a task due today will show up here.
          </p>
        ) : null}
        <ul className="divide-y divide-border">
          {courses.slice(0, 4).map((course) => (
            <ContinueRow
              key={course.key}
              kind="Course"
              title={course.key}
              seconds={course.activeSeconds}
              share={sharePercent(course.activeSeconds, weekLearning)}
              href="/learning"
            />
          ))}
          {plan.slice(0, courses.length > 0 ? 2 : 4).map((task) => (
            <ContinueRow
              key={task.id}
              kind="Task"
              title={task.title}
              note={estimateText(task.estimatedSeconds)}
              href="/tasks"
            />
          ))}
        </ul>
      </section>
    </div>
  );
}

const TRACK_TONE = {
  learn: "border-l-4 border-l-card-coral bg-card-coral shadow-lift",
  plan: "border-l-4 border-l-card-gold bg-card-gold shadow-lift",
  code: "border-l-4 border-l-card-rose bg-card-rose shadow-lift",
};

function TrackCard({ eyebrow, icon, title, detail, share, shareLabel, href, tone = "learn" }) {
  return (
    <Link
      to={href}
      className={`flex min-h-32 items-center gap-2 rounded-xl border p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${TRACK_TONE[tone] ?? TRACK_TONE.learn}`}
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-foreground/70">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-card/55 text-foreground dark:bg-card/10">
            {createElement(icon, { className: "h-3 w-3", "aria-hidden": true })}
          </span>
          {eyebrow}
        </span>
        <span className="mt-2 line-clamp-2 block text-base font-semibold text-foreground">{title}</span>
        {share != null ? (
          <span className="mt-2 block">
            <span className="block h-1.5 overflow-hidden rounded-full bg-border" aria-hidden="true">
              <span className="block h-full rounded-full bg-foreground/70" style={{ width: `${share}%` }} />
            </span>
            <span className="mt-1 block text-xs text-foreground/70">{shareLabel}</span>
          </span>
        ) : null}
        <span className="mt-1 block text-base text-foreground/70">{detail}</span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-foreground/50" aria-hidden="true" />
    </Link>
  );
}

function StreakCard({ days, selectedKey, active, streak, activeThisWeek, known, state, onSelectDay }) {
  return (
    <section aria-label="This week" className="flex h-full flex-col rounded-xl border border-border bg-card-sky p-3 text-foreground shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <Zap className="h-4 w-4" aria-hidden="true" />
        <p className="text-2xl font-bold leading-none">{known ? streak : "–"}</p>
      </div>
      <h2 className="mt-2 text-lg font-semibold">Day streak</h2>
      <p className="mb-4 mt-1 text-base text-muted-foreground">
        {state === "unconfigured"
          ? "Not connected. Recorded days show up after Supabase is configured."
          : state === "loading"
            ? "Loading this week…"
            : state === "error"
              ? "Could not load recorded days."
              : known
                ? `${activeThisWeek} day${activeThisWeek === 1 ? "" : "s"} with recorded time this week. The count stops at the edge of this week.`
                : "Recorded days show up when the week has loaded."}
      </p>
      <div className="mt-3 grid grid-cols-7 gap-1" role="group" aria-label="Days this week">
        {days.map((day) => {
          const on = active.has(day.key);
          const selected = day.key === selectedKey;
          return (
            <button
              key={day.key}
              type="button"
              aria-pressed={selected}
              aria-label={`${day.weekday} ${day.dayNumber}${on ? ", time recorded" : ", nothing recorded"}`}
              onClick={() => onSelectDay(day.key)}
              className="flex min-h-9 flex-col items-center justify-center gap-1 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="text-xs uppercase text-muted-foreground">{String(day.weekday).slice(0, 1)}</span>
              <span
                className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${
                  selected ? "ring-2 ring-ring" : ""
                } ${on ? "bg-progress text-progress-foreground" : "bg-muted text-muted-foreground"}`}
              >
                {day.dayNumber}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function ContinueRow({ kind, title, seconds, share, note, href }) {
  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-2 sm:px-4">
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{kind}</p>
        <p className="truncate font-medium">{title}</p>
        {share != null ? (
          <div className="mt-1 flex items-center gap-2">
            <div className="h-1.5 max-w-xs flex-1 overflow-hidden rounded-full bg-border" aria-hidden="true">
              <div className="h-full rounded-full bg-foreground/70" style={{ width: `${share}%` }} />
            </div>
            <span className="text-xs text-muted-foreground">{share}% of this week</span>
          </div>
        ) : note ? (
          <p className="mt-1 text-xs text-muted-foreground">{note}</p>
        ) : null}
      </div>
      {seconds != null ? (
        <p className="text-base text-muted-foreground">{durationText(seconds)}</p>
      ) : null}
      <Link
        to={href}
        className="inline-flex min-h-9 items-center rounded-lg bg-foreground px-3 text-base font-semibold text-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Continue
      </Link>
    </li>
  );
}

function statusTitle(state) {
  if (state === "loading") return "Loading…";
  if (state === "error") return "Could not load";
  if (state === "unconfigured") return "Not connected";
  return "Nothing recorded";
}

function statusDetail(state) {
  if (state === "loading") return "Loading recorded time.";
  if (state === "unconfigured") return "Configure Supabase to load this.";
  if (state === "error") return "The week could not be loaded.";
  return "";
}

function localDayOf(beat, timeZone) {
  return beat?.occurredAt ? localDayKey(beat.occurredAt, timeZone) : null;
}
