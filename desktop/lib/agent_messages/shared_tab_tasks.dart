import 'dart:async';

import 'package:flutter/material.dart';

import '../core/open_in_browser.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/skeleton.dart';
import '../state/app_state.dart';
import '../widgets/desktop_chrome.dart';
import 'shared_tab_errors.dart';
import 'shared_tab_placement.dart' show plainSharedText, shortSharedText;
import 'shared_tabs.dart';
import 'shared_tabs_model.dart';

/// One line for why a tab's tasks could not be read (1c spec, Errors).
String sharedTasksErrorText(String code) => switch (code) {
  'GH_MISSING' => 'Install the GitHub CLI (gh) on this computer to see tasks.',
  'GH_SIGNED_OUT' => 'Run gh auth login on this computer to see tasks.',
  'RATE_LIMITED' || 'TIMEOUT' || 'GH_FAILED' => 'GitHub didn\'t answer. Try again later.',
  _ => sharedTabErrorText(SharedTabsFailure(code, '')),
};

/// Tasks: the GitHub issues agents of a shared tab work on, with their pull
/// request and CI. Enter or a click opens the issue; an assignee opens its
/// pane. Issue titles come from other accounts and are plain text.
class SharedTabTasks extends StatefulWidget {
  const SharedTabTasks({
    super.key,
    required this.app,
    required this.sharedTabId,
    required this.deskTabId,
    required this.onOpenPane,
  });

  final AppNotifier app;
  final String sharedTabId, deskTabId;

  /// Focuses the pane of a roster harness (the view closes first).
  final void Function(String machineId, String agentId) onOpenPane;

  @override
  State<SharedTabTasks> createState() => SharedTabTasksState();
}

class SharedTabTasksState extends State<SharedTabTasks> {
  @override
  void initState() {
    super.initState();
    // Not while the tree is building: the read notifies its listeners at once.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) reload();
    });
  }

  void reload() => unawaited(widget.app.sharedTabs.loadTasks(widget.sharedTabId));

  void _open(String url) => unawaited(openInBrowser(Uri.parse(url)));

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final shares = widget.app.sharedTabs;
    return ListenableBuilder(
      listenable: shares,
      builder: (context, _) {
        final tasks = shares.tasksFor(widget.sharedTabId);
        final tab = shares.tabForDesk(widget.deskTabId);
        final error = tasks.error;
        if (!tasks.loaded && error == null) {
          // Not read yet (or reading): the shape of the table, never "No tasks".
          return const SkeletonList(
            key: ValueKey('shared-tasks-loading'),
            rows: 4,
            semanticsLabel: 'Loading tasks',
          );
        }
        return ListView(
          key: const ValueKey('shared-tasks'),
          shrinkWrap: true,
          padding: EdgeInsets.zero,
          children: [
            if (error != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 4, 12, 8),
                child: Text(
                  sharedTasksErrorText(error),
                  key: const ValueKey('shared-tasks-error'),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: DesktopChrome.metadata(color: Theme.of(context).colorScheme.error),
                ),
              ),
            if (tasks.loaded && tasks.rows.isEmpty && error == null)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 24),
                child: Text(
                  'No tasks for this tab. Agents in it create them as GitHub issues.',
                  key: const ValueKey('shared-tasks-empty'),
                  textAlign: TextAlign.center,
                  style: DesktopChrome.text(size: 13, color: DesktopChrome.muted),
                ),
              ),
            if (tasks.rows.isNotEmpty) ...[
              const _Header(),
              for (final row in tasks.rows) _TaskRow(
                key: ValueKey('shared-task:${row.repo}#${row.issue}'),
                row: row,
                harness: _harnessOf(tab, row.assignee),
                onOpenIssue: () => _open(row.url),
                onOpenPr: row.pr == null ? null : () => _open(row.pr!.url),
                onOpenPane: widget.onOpenPane,
              ),
              if (tasks.truncated)
                Padding(
                  padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
                  child: Text('Showing the newest tasks.', style: DesktopChrome.metadata()),
                ),
            ],
          ],
        );
      },
    );
  }

  /// The roster harness the marker names: its account and its harness name.
  static SharedTabHarness? _harnessOf(
    SharedTab? tab,
    ({String accountId, String harness})? assignee,
  ) {
    if (tab == null || assignee == null) return null;
    for (final h in tab.harnesses) {
      if (h.accountId == assignee.accountId && h.name == assignee.harness) return h;
    }
    return null;
  }
}

const _repoWidth = 104.0, _issueWidth = 48.0, _assigneeWidth = 104.0, _prWidth = 56.0, _ciWidth = 56.0;

class _Header extends StatelessWidget {
  const _Header();

  @override
  Widget build(BuildContext context) {
    Widget cell(String text, {double? width}) {
      final t = Text(text, maxLines: 1, overflow: TextOverflow.ellipsis, style: DesktopChrome.metadata());
      return width == null ? Expanded(child: t) : SizedBox(width: width, child: t);
    }

    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 0, 12, 4),
      child: Row(
        children: [
          cell('Repo', width: _repoWidth),
          cell('Issue', width: _issueWidth),
          cell('Title'),
          cell('Assignee', width: _assigneeWidth),
          cell('Pull request', width: _prWidth),
          cell('CI', width: _ciWidth),
        ],
      ),
    );
  }
}

class _TaskRow extends StatelessWidget {
  const _TaskRow({
    super.key,
    required this.row,
    required this.harness,
    required this.onOpenIssue,
    required this.onOpenPr,
    required this.onOpenPane,
  });

  final SharedTaskRow row;
  final SharedTabHarness? harness;
  final VoidCallback onOpenIssue;
  final VoidCallback? onOpenPr;
  final void Function(String machineId, String agentId) onOpenPane;

  Widget _link(String text, VoidCallback? onPressed, {Key? key, required double width}) => SizedBox(
    width: width,
    child: TextButton(
      key: key,
      onPressed: onPressed,
      style: TextButton.styleFrom(
        foregroundColor: DesktopChrome.accent,
        minimumSize: const Size(0, 32),
        padding: const EdgeInsets.symmetric(horizontal: 4),
        alignment: Alignment.centerLeft,
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        splashFactory: NoSplash.splashFactory,
      ),
      child: Text(text, maxLines: 1, overflow: TextOverflow.ellipsis, style: DesktopChrome.control()),
    ),
  );

  @override
  Widget build(BuildContext context) {
    final highContrast = MediaQuery.highContrastOf(context);
    final repo = shortSharedText(row.repo, 40);
    final title = plainSharedText(row.title);
    final assignee = row.assignee;
    final assigneeName = assignee == null ? '' : shortSharedText(assignee.harness, 24);
    final pr = row.pr;
    final ci = pr == null || pr.ci == 'none' ? '' : shortSharedText(pr.ci, 12);
    return Row(
      children: [
        Expanded(
          child: TextButton(
            key: ValueKey('shared-task-open:${row.repo}#${row.issue}'),
            onPressed: onOpenIssue,
            style: TextButton.styleFrom(
              foregroundColor: DesktopChrome.foreground,
              minimumSize: const Size(0, 36),
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
              alignment: Alignment.centerLeft,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(DesktopChrome.rowRadius)),
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
              splashFactory: NoSplash.splashFactory,
            ).copyWith(
              side: WidgetStateProperty.resolveWith(
                (states) => BorderSide(
                  width: 1.5,
                  color: states.contains(WidgetState.focused)
                      ? (highContrast ? DesktopChrome.accent : DesktopChrome.focusRing)
                      : Colors.transparent,
                ),
              ),
            ),
            child: Row(
              children: [
                SizedBox(
                  width: _repoWidth - 12,
                  child: Text(repo, maxLines: 1, overflow: TextOverflow.ellipsis, style: DesktopChrome.metadata()),
                ),
                SizedBox(
                  width: _issueWidth,
                  child: Text(
                    '#${row.issue}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: DesktopChrome.control(color: row.state == 'open' ? null : DesktopChrome.muted),
                  ),
                ),
                Expanded(
                  child: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: DesktopChrome.control()),
                ),
              ],
            ),
          ),
        ),
        if (assignee == null)
          const SizedBox(width: _assigneeWidth)
        else if (harness case final h?)
          _link(
            assigneeName,
            () => onOpenPane(h.machineId, h.agentId),
            key: ValueKey('shared-task-assignee:${row.repo}#${row.issue}'),
            width: _assigneeWidth,
          )
        else
          SizedBox(
            width: _assigneeWidth,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4),
              child: Text(
                assigneeName,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: DesktopChrome.metadata(),
              ),
            ),
          ),
        if (pr == null)
          const SizedBox(width: _prWidth)
        else
          _link('#${pr.number}', onOpenPr, key: ValueKey('shared-task-pr:${row.repo}#${row.issue}'), width: _prWidth),
        SizedBox(
          width: _ciWidth,
          child: Text(ci, maxLines: 1, overflow: TextOverflow.ellipsis, style: DesktopChrome.metadata()),
        ),
      ],
    );
  }
}
