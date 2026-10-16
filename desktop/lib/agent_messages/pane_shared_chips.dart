import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/workspace_bar_style.dart';
import '../state/app_state.dart';
import 'shared_tab_placement.dart' show plainSharedText;
import 'shared_tabs_model.dart';

/// What a pane's header says about its place in a shared tab.
typedef SharedPaneChipState = ({
  bool leader,
  SharedTabPending? joining,
  SharedTab? tab,
});

SharedPaneChipState sharedPaneChipState(
  AppNotifier app,
  String machineId,
  String agentId,
) {
  final tab = app.sharedTabHolding(machineId, agentId);
  if (tab == null) return (leader: false, joining: null, tab: null);
  final leader = tab.leader;
  final joining = app.sharedTabs.snapshot.pending
      .where(
        (p) =>
            p.op == 'add' &&
            p.sharedTabId == tab.sharedTabId &&
            p.machineId == machineId &&
            p.agentId == agentId,
      )
      .firstOrNull;
  return (
    leader:
        leader != null &&
        leader.machineId == machineId &&
        leader.agentId == agentId,
    joining: joining,
    tab: tab,
  );
}

/// `Leader`, `Joining…` and Remove from Tab, beside the title of an own
/// harness's pane in a shared tab. Another account's strings are plain text on
/// one ellipsized line. Nothing is drawn outside a shared tab.
class PaneSharedChips extends StatelessWidget {
  const PaneSharedChips({
    super.key,
    required this.app,
    required this.machineId,
    required this.agentId,
    required this.style,
  });

  final AppNotifier app;
  final String machineId, agentId;
  final TextStyle style;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([app.sharedTabs, app]),
    builder: (context, _) {
      final state = sharedPaneChipState(app, machineId, agentId);
      final tab = state.tab;
      if (tab == null) return const SizedBox.shrink();
      final ink = style.color ?? grid.AppPalette.textPrimary;
      final quiet = style.copyWith(color: ink.withValues(alpha: .7));
      final gap = workspaceBarCellSizeOf(context).width;
      Widget line(String text, TextStyle s, {String? tip, Key? key}) =>
          Flexible(
            child: Padding(
              padding: EdgeInsets.only(left: gap),
              child: Tooltip(
                message: tip ?? text,
                child: Text(
                  text,
                  key: key,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: s,
                ),
              ),
            ),
          );
      final owner = plainSharedText(tab.ownerEmail);
      final joining = state.joining;
      final focused = app.focusedPane;
      final remove =
          app.canRemoveFromSharedTab(machineId, agentId) &&
          focused?.machineId == machineId &&
          focused?.agentId == agentId;
      return Flexible(
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (state.leader)
              line('Leader', quiet, key: const ValueKey('pane-chip-leader')),
            if (joining != null)
              line(
                'Joining…',
                quiet.copyWith(fontStyle: FontStyle.italic),
                key: const ValueKey('pane-chip-joining'),
                tip: owner.isEmpty
                    ? 'Waiting for the owner\'s computer'
                    : 'Waiting for $owner\'s computer',
              ),
            if (remove)
              Padding(
                padding: EdgeInsets.only(left: gap),
                child: InkWell(
                  key: const ValueKey('pane-chip-remove-from-tab'),
                  onTap: () => app.removeFromSharedTab(machineId, agentId),
                  child: Text('Remove from Tab', maxLines: 1, style: quiet),
                ),
              ),
          ],
        ),
      );
    },
  );
}
