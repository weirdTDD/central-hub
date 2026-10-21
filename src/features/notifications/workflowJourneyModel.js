// Pure journey rules for one workflow.
// Every node is a stored fact. Nothing is invented to fill the timeline.

import { describeTrigger } from "./workflowEngine.js";

const OPEN_RUN = new Set(["scheduled", "running", "awaiting_approval"]);
const OPEN_NOTE = new Set(["scheduled", "sent", "delivered"]);

const PHASES = [
  { id: "start", label: "Start" },
  { id: "live", label: "Live" },
  { id: "wrap", label: "Wrap up" },
];

function runDetail(run) {
  if (run.error) return run.error;
  if (typeof run.result?.reason === "string" && run.result.reason) return run.result.reason;
  return `Attempt ${run.attempt}.`;
}

function notificationNodes(note) {
  if (!note) return [];
  const title = note.title || "Notification";
  const nodes = [];
  if (note.sent_at) {
    nodes.push({
      key: "note-sent",
      title: "Sent",
      detail: `${title} was handed to the in-app channel.`,
      time: note.sent_at,
    });
  }
  if (note.delivered_at) {
    nodes.push({
      key: "note-delivered",
      title: "Delivered",
      detail: `${title} is in the inbox.`,
      time: note.delivered_at,
    });
  }
  if (note.acknowledged_at) {
    nodes.push({
      key: "note-ack",
      title: "Acknowledged",
      detail: "You marked this notification seen.",
      time: note.acknowledged_at,
    });
  }
  if (note.snoozed_until && note.status !== "acknowledged") {
    nodes.push({
      key: "note-snooze",
      title: "Snoozed",
      detail: `${title} is held until the snooze ends.`,
      time: note.snoozed_until,
    });
  }
  if (nodes.length === 0) {
    nodes.push({
      key: `note-${note.status}`,
      title: `Notification · ${String(note.status).replace(/_/g, " ")}`,
      detail: title,
      time: note.scheduled_for || note.created_at,
      tone: note.status === "failed" ? "failed" : undefined,
    });
  } else if (note.status === "failed" || note.status === "cancelled") {
    nodes.push({
      key: `note-${note.status}`,
      title: note.status === "failed" ? "Delivery failed" : "Cancelled",
      detail: title,
      time: note.updated_at,
      tone: note.status === "failed" ? "failed" : undefined,
    });
  }
  return nodes;
}

/**
 * Builds the stage rail and the timeline for one workflow.
 *
 * @param {object} input
 * @param {object} input.workflow
 * @param {Array} input.runs newest first
 * @param {Array} input.notifications newest first
 * @param {Array} input.approvals newest first
 */
export function buildWorkflowJourney({ workflow, runs, notifications, approvals }) {
  const latestRun = runs.find((run) => run.workflow_id === workflow.id) ?? null;
  const latestNote =
    notifications.find((note) => note.workflow_id === workflow.id) ?? null;
  const pendingApproval =
    approvals.find(
      (item) => item.workflow_id === workflow.id && item.status === "pending"
    ) ?? null;

  const steps = [
    {
      key: "defined",
      title: "Defined",
      detail: describeTrigger(workflow.trigger_config),
      time: workflow.created_at,
    },
  ];

  if (latestRun) {
    steps.push({
      key: `run-${latestRun.id}`,
      title: `Latest run · ${String(latestRun.status).replace(/_/g, " ")}`,
      detail: runDetail(latestRun),
      time: latestRun.finished_at || latestRun.started_at || latestRun.created_at,
      tone: latestRun.status === "failed" ? "failed" : undefined,
    });
  }

  if (pendingApproval) {
    steps.push({
      key: `approval-${pendingApproval.id}`,
      title: "Waiting for you",
      detail: "This workflow will not act until you approve or reject it.",
      time: pendingApproval.created_at,
    });
  }

  steps.push(...notificationNodes(latestNote));

  if (!workflow.enabled) {
    steps.push({
      key: "off",
      title: "Switched off",
      detail: "No occurrence is planned while this workflow is switched off.",
      time: workflow.updated_at,
    });
  } else if (workflow.next_run_at) {
    steps.push({
      key: "next",
      title: "Next occurrence",
      detail:
        "Planned in the database. The worker runs it only while that process is going.",
      time: workflow.next_run_at,
    });
  }

  let currentKey = "defined";
  if (pendingApproval) currentKey = `approval-${pendingApproval.id}`;
  else if (latestRun && OPEN_RUN.has(latestRun.status)) currentKey = `run-${latestRun.id}`;
  else if (latestNote && OPEN_NOTE.has(latestNote.status)) {
    if (latestNote.status === "delivered" && latestNote.delivered_at) currentKey = "note-delivered";
    else if (latestNote.status === "sent" && latestNote.sent_at) currentKey = "note-sent";
    else currentKey = steps.find((step) => step.key.startsWith("note-"))?.key ?? "defined";
  } else if (!workflow.enabled) currentKey = "off";
  else if (workflow.next_run_at) currentKey = "next";
  else if (latestNote?.acknowledged_at) currentKey = "note-ack";
  else if (latestRun) currentKey = `run-${latestRun.id}`;

  const currentIndex = Math.max(
    0,
    steps.findIndex((step) => step.key === currentKey)
  );
  const marked = steps.map((step, index) => ({
    ...step,
    state: index < currentIndex ? "done" : index === currentIndex ? "current" : "upcoming",
  }));
  const current = marked[currentIndex];

  let phase = "live";
  if (current.key === "defined") phase = "start";
  else if (current.key === "off") phase = latestRun || latestNote ? "wrap" : "start";
  else if (current.key === "note-ack") phase = "wrap";
  else if (
    current.key.startsWith("run-") &&
    latestRun &&
    !OPEN_RUN.has(latestRun.status) &&
    !workflow.enabled
  ) {
    phase = "wrap";
  }

  return { steps: marked, current, phase };
}

