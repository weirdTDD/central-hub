import { createContext, useContext } from "react";

/** Lets the reminder list reload after a reminder fires on another part of the app. */
export const AlertRevisionContext = createContext({
  revision: 0,
  runnerError: "",
  live: [],
  dismiss() {},
});

export function useAlertRevision() {
  return useContext(AlertRevisionContext);
}
