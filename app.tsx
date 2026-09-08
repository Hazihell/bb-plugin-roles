// bb-plugin-roles — a BB plugin frontend entry.
//
// Registers the roles settings editor (RL-1): manage the role cast without
// the CLI. Compiled by `bb plugin build` into dist/app.js + dist/app.css;
// loaded by BB, never imported directly.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { RolesSettingsSection } from "./components/roles/RolesSettingsSection";

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "roles",
    title: "Roles",
    description: "Manage the cast of roles bb roles spawn picks from.",
    component: RolesSettingsSection,
  });
});
