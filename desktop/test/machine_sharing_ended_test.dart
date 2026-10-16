import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late AppNotifier app;
  AppNotifier withMachine(Machine machine) {
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    app.machines = [machine];
    app.machineStates[machine.machineId] = MachineState(machine)
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected;
    return app;
  }

  tearDown(() => app.dispose());

  // Seen 2026-10-16: the owner stopped sharing, and the person's pane said
  // "Machine selection failed: NOT_YOUR_MACHINE" with a Retry that could never work.
  test('a machine its owner stopped sharing says who, offers no retry, and is remembered for its panes', () async {
    app = withMachine(
      const Machine(
        machineId: 'studio',
        authMode: MachineAuthMode.remote,
        name: 'MacBook Pro',
        machineShare: MachineShare(
          ownerName: 'Dee',
          ownerEmail: 'dee@acme.io',
          via: 'email',
          added: true,
        ),
      ),
    );
    await app.handleEventForTest('studio', {
      'type': 'machine_select_error',
      'payload': {'machineId': 'studio', 'error': 'NOT_YOUR_MACHINE'},
    });
    expect(app.lastError, 'Dee stopped sharing MacBook Pro with you.');
    expect(app.lastErrorRetryable, isFalse);
    expect(app.sharingEnded('studio'), (name: 'MacBook Pro', owner: 'Dee'));
    expect(
      app.stateOf('studio')!.connectionStatus,
      ConnectionStatus.disconnected,
    );
  });

  test('the account’s own machine refused is said in words, retryable only when retrying can help', () async {
    app = withMachine(
      const Machine(
        machineId: 'own',
        authMode: MachineAuthMode.remote,
        name: 'Studio',
      ),
    );
    await app.handleEventForTest('own', {
      'type': 'machine_select_error',
      'payload': {'machineId': 'own', 'error': 'NOT_YOUR_MACHINE'},
    });
    expect(app.lastError, 'Studio is no longer on your account.');
    expect(app.lastErrorRetryable, isFalse);
    expect(app.sharingEnded('own'), isNull);
    await app.handleEventForTest('own', {
      'type': 'machine_select_error',
      'payload': {'machineId': 'own', 'error': 'MACHINE_START_FAILED'},
    });
    expect(
      app.lastError,
      'Could not connect to Studio. Try again in a moment.',
    );
    expect(app.lastErrorRetryable, isTrue);
  });

  test('every refusal code reads as a sentence', () {
    for (final code in [
      'NOT_YOUR_MACHINE',
      'MACHINE_ENV_MISMATCH',
      'MACHINE_PAYMENT_PENDING',
      'MACHINE_SUBSCRIPTION_REQUIRED',
      'SOMETHING_NEW',
    ]) {
      final text = machineSelectErrorText(code, 'Studio');
      expect(text, contains('Studio'));
      expect(text, isNot(contains('_')), reason: code);
    }
    app = withMachine(
      const Machine(machineId: 'x', authMode: MachineAuthMode.remote),
    );
  });
}
