import { Modal, Notice, Setting, type App, type TextAreaComponent } from "obsidian";

import { t } from "../lang/helpers";
import {
  BatchMigration,
  normalizeExcludedDirectories,
  type MigrationPhase,
  type MigrationReason,
  type MigrationResult,
} from "./batchMigration";

const VISIBLE_RESULTS = 100;
const PREVIEW_NOTES = 20;
const phaseLabels: Record<MigrationPhase, Parameters<typeof t>[0]> = {
  idle: "Ready to scan",
  scanning: "Scanning notes...",
  ready: "Review migration",
  running: "Migrating attachments...",
  paused: "Migration paused",
  cancelling: "Cancelling...",
  completed: "Migration completed",
  cancelled: "Migration cancelled",
  error: "Migration stopped",
};
const reasonLabels: Record<MigrationReason, Parameters<typeof t>[0]> = {
  "open-note": "The note was open, so it was skipped. Close it and scan again to migrate it.",
  "note-changed": "Note changed during migration; original content was kept.",
  "note-missing": "Note no longer exists.",
  "source-changed": "A local attachment changed or is unavailable; its link was kept.",
  "read-error": "Could not read or update this note.",
  "upload-error": "An attachment could not be uploaded; its link was kept.",
  "image-limit": "This note exceeds the remote image limit; remote links were kept.",
  cancelled: "Migration cancelled; remaining links were kept.",
  "no-attachments": "No attachments need to be migrated.",
};

function countLabel(key: Parameters<typeof t>[0], count: number): string {
  return t(key).replace("{count}", String(count));
}
function resultLine(result: MigrationResult): string {
  const status =
    result.status === "updated"
      ? t("Updated")
      : result.status === "failed"
        ? t("Failed")
        : t("Skipped");
  const reason = result.reason ? ` — ${t(reasonLabels[result.reason])}` : "";
  return `${result.path} · ${status} · ${t("Updated attachments:")} ${result.updated} · ${t("Failed:")} ${result.failed} · ${t("Not applied:")} ${result.notApplied}${reason}`;
}

/** The panel observes a task; closing it never owns the task's lifetime. */
export class MigrationModal extends Modal {
  private readonly migration: BatchMigration;
  private readonly unsubscribe: () => void;
  private opened = false;
  private disposed = false;
  private excluded = "";
  private previousPhase: MigrationPhase = "idle";
  private body?: HTMLElement;
  private exclusionInput?: TextAreaComponent;
  private renderTimer?: number;

  constructor(app: App, migration: BatchMigration) {
    super(app);
    this.migration = migration;
    this.unsubscribe = migration.subscribe(() => {
      const { phase } = migration.state;
      if (
        !this.opened &&
        phase !== this.previousPhase &&
        (phase === "completed" || phase === "cancelled" || phase === "error")
      ) {
        new Notice(
          `${t(phaseLabels[phase])}
${t("Run “Migrate vault attachments” to view the results.")}`,
          10000,
        );
      }
      this.previousPhase = phase;
      if (this.opened) this.scheduleRender();
    });
  }

  /** Progress updates can arrive per note; coalesce them into one paint. */
  private scheduleRender(): void {
    if (!this.opened || this.renderTimer !== undefined) return;
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = undefined;
      if (this.opened) this.render();
    }, 100);
  }

  show(): void {
    if (!this.opened) this.open();
  }
  onOpen(): void {
    this.opened = true;
    this.setTitle(t("Migrate vault attachments"));
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", {
      text: t(
        "Scans Markdown notes, reviews the scope, then uploads referenced attachments and updates their links. Unreferenced vault files are not uploaded, and local source files are kept.",
      ),
    });
    contentEl.createEl("p", {
      text: t(
        "Open notes are skipped. You can close this panel while the task runs; quitting Obsidian stops the task, and progress is not saved.",
      ),
    });
    new Setting(contentEl)
      .setName(t("Excluded folders"))
      .setDesc(
        t(
          "One vault-relative folder per line, for example Templates or Attachments/private. Notes and local files in these folders are skipped.",
        ),
      )
      .addTextArea((input) => {
        this.exclusionInput = input;
        input.setValue(this.excluded).onChange((value) => {
          this.excluded = value;
          this.migration.invalidate();
        });
        input.inputEl.setAttribute("rows", "3");
      });
    this.body = contentEl.createDiv();
    this.render();
  }
  onClose(): void {
    this.opened = false;
    this.contentEl.empty();
    if (
      !this.disposed &&
      ["running", "paused", "scanning", "cancelling"].includes(this.migration.state.phase)
    ) {
      new Notice(t("Run “Migrate vault attachments” to return to this task."), 7000);
    }
  }
  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    if (this.renderTimer !== undefined) window.clearTimeout(this.renderTimer);
    this.renderTimer = undefined;
    if (this.opened) this.close();
  }

  private render(): void {
    const contentEl = this.body;
    if (!contentEl) return;
    const state = this.migration.state;
    const busy = ["running", "paused", "scanning", "cancelling"].includes(state.phase);
    this.exclusionInput?.setDisabled(busy);
    contentEl.empty();
    contentEl.createEl("h3", { text: t(phaseLabels[state.phase]) });
    if (state.phase === "scanning")
      contentEl.createEl("p", { text: `${state.scanned} / ${state.total}` });
    if (state.current) contentEl.createEl("p", { text: `${t("Current note:")} ${state.current}` });
    if (state.item) contentEl.createEl("p", { text: `${t("Current attachment:")} ${state.item}` });
    if (state.pauseReason)
      contentEl.createEl("p", {
        text: t(
          state.pauseReason === "rate-limit"
            ? "The image server requested a pause. Review the results before resuming."
            : "Three consecutive operations failed. Check the upload tool and network before resuming.",
        ),
      });
    if (state.error)
      contentEl.createEl("p", {
        text: state.error.includes("settings-changed")
          ? t("Upload settings changed. Scan again before starting a new migration.")
          : state.error,
      });
    const plan = state.plan;
    if (plan && state.phase === "ready") {
      contentEl.createEl("p", {
        text: [
          countLabel("Notes to migrate: {count}", plan.paths.length),
          countLabel("Local files: {count}", plan.localFiles),
          countLabel("Remote images: {count}", plan.remoteImages),
        ].join(" · "),
      });
      if (plan.missingFiles)
        contentEl.createEl("p", {
          text: countLabel(
            "Missing local references: {count}. Their links will be kept.",
            plan.missingFiles,
          ),
        });
      if (plan.scanErrors.length)
        contentEl.createEl("p", {
          text: countLabel("Notes that could not be scanned: {count}", plan.scanErrors.length),
        });
      const list = contentEl.createEl("ul");
      for (const path of plan.paths.slice(0, PREVIEW_NOTES)) list.createEl("li", { text: path });
      if (plan.paths.length > PREVIEW_NOTES)
        contentEl.createEl("p", {
          text: countLabel("Showing the first {count} notes.", PREVIEW_NOTES),
        });
    }
    if (plan && state.phase !== "ready") {
      contentEl.createEl("p", {
        text: `${t("Processed notes:")} ${state.processed} / ${plan.paths.length}`,
      });
      const totals = state.results.reduce(
        (sum, result) => ({
          updated: sum.updated + result.updated,
          failed: sum.failed + result.failed,
          reused: sum.reused + result.reused,
          notApplied: sum.notApplied + result.notApplied,
        }),
        { updated: 0, failed: 0, reused: 0, notApplied: 0 },
      );
      contentEl.createEl("p", {
        text: `${t("Updated attachments:")} ${totals.updated} · ${t("Failed:")} ${totals.failed} · ${t("Skipped duplicate uploads:")} ${totals.reused} · ${t("Not applied:")} ${totals.notApplied}`,
      });
    }
    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText(t("Scan notes"))
          .setDisabled(busy)
          .onClick(async () => {
            await this.migration.scan(normalizeExcludedDirectories(this.excluded));
          }),
      )
      .addButton((button) =>
        button
          .setButtonText(t("Start migration"))
          .setCta()
          .setDisabled(state.phase !== "ready" || !plan?.paths.length)
          .onClick(async () => {
            await this.migration.start();
          }),
      )
      .addButton((button) =>
        button
          .setButtonText(t(state.phase === "paused" ? "Resume" : "Pause"))
          .setDisabled(state.phase !== "running" && state.phase !== "paused")
          .onClick(() => {
            if (state.phase === "paused") this.migration.resume();
            else this.migration.pause();
          }),
      )
      .addButton((button) =>
        button
          .setButtonText(t("Cancel"))
          .setDisabled(!busy || state.phase === "cancelling")
          .onClick(() => {
            this.migration.cancel();
          }),
      );
    contentEl.createEl("p", {
      text: t(
        "Attachments are processed one at a time. A failed upload keeps the original link. Cancelling does not remove files that were already uploaded.",
      ),
    });
    if (state.results.length) {
      new Setting(contentEl).setName(t("Migration results")).addButton((button) =>
        button.setButtonText(t("Copy results")).onClick(async () => {
          try {
            await navigator.clipboard.writeText(
              [
                t(phaseLabels[state.phase]),
                ...state.results.map(
                  (result) => `${resultLine(result)}${result.details ? `\n${result.details}` : ""}`,
                ),
              ].join("\n"),
            );
            new Notice(t("Migration results copied."));
          } catch (error) {
            new Notice(`${t("Could not copy migration results:")} ${String(error)}`);
          }
        }),
      );
      const list = contentEl.createEl("ul");
      for (const result of state.results.slice(-VISIBLE_RESULTS)) {
        const row = list.createEl("li", { text: resultLine(result) });
        if (result.details) row.createEl("pre", { text: result.details.slice(0, 2000) });
      }
      if (state.results.length > VISIBLE_RESULTS)
        contentEl.createEl("p", {
          text: countLabel(
            "Showing the last {count} results. Copy results to include all entries.",
            VISIBLE_RESULTS,
          ),
        });
    }
  }
}
