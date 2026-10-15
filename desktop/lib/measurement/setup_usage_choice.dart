import 'package:flutter/material.dart';

import '../shared/widgets/setting_row.dart';
import 'product_measurement.dart';

/// Settings-only control for this computer before an account preference is known.
class SetupUsageChoice extends StatefulWidget {
  const SetupUsageChoice({super.key, required this.measurement});
  final ProductMeasurement measurement;

  @override
  State<SetupUsageChoice> createState() => _SetupUsageChoiceState();
}

class _SetupUsageChoiceState extends State<SetupUsageChoice> {
  bool _saving = false;
  String? _error;

  Future<void> _set(bool enabled) async {
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await widget.measurement.setSignedOutSharing(enabled);
    } catch (_) {
      if (mounted) {
        setState(
          () => _error =
              'Couldn’t save this setting for the next launch. Try again.',
        );
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.measurement,
    builder: (context, _) => SingleChildScrollView(
      child: SettingRow(
        title: 'Share product usage data',
        detail:
            'Help improve Harness by sharing setup and sign-in counts and duration statistics. '
            'Your account details, prompts, code, files, and conversations are never included.',
        controlSemanticLabel: 'Share product usage data',
        control: Switch(
          value: widget.measurement.signedOutSharing,
          onChanged: widget.measurement.choiceLoaded && !_saving ? _set : null,
        ),
        footer: _error == null
            ? const Text(
                'Applies to this computer before sign-in and is remembered for future launches. '
                'Turning this off also disables sharing for your account when you sign in.',
              )
            : Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(_error!),
                  TextButton(
                    onPressed: _saving
                        ? null
                        : () => _set(widget.measurement.signedOutSharing),
                    child: const Text('Retry saving'),
                  ),
                ],
              ),
      ),
    ),
  );
}
