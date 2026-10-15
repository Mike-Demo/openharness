import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/app_shell.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/measurement/product_measurement.dart';
import 'package:harness/measurement/setup_usage_choice.dart';
import 'package:harness/settings/settings_screen.dart';
import 'package:harness/state/app_state.dart';
import 'package:package_info_plus/package_info_plus.dart';

import 'support/capture.dart';
import 'support/memory_key_value_store.dart';
import 'support/real_fonts.dart';

class _FailingWriteStore extends MemoryKeyValueStore {
  bool fail = true;
  @override
  Future<void> write(String key, String value) async {
    if (fail) throw StateError('PRIVATE_CANARY');
    await super.write(key, value);
  }
}

void main() {
  final capture = Platform.environment['HARNESS_SETUP_CHOICE_CAPTURE_DIR'];
  setUpAll(() async {
    await loadRealFonts();
    await loadCaptureFonts(capture);
  });
  PackageInfo.setMockInitialValues(
    appName: 'Harness',
    packageName: 'ai.autonomous.harness',
    version: '1.2.80',
    buildNumber: '80',
    buildSignature: '',
  );

  for (final status in [
    AppStatus.unauthenticated,
    AppStatus.preparingEnvironment,
  ]) {
    testWidgets(
      'setup has no checkbox and its menu opens Privacy: ${status.name}',
      (tester) async {
        tester.view.devicePixelRatio = 1;
        tester.view.physicalSize = const Size(1100, 760);
        addTearDown(tester.view.reset);
        final store = MemoryKeyValueStore();
        final usage = ProductMeasurement(
          surface: 'desktop',
          automatic: false,
          setupStorage: store,
          sendSetup: (_) async => {'accepted': true},
        );
        await usage.setupChoiceReady;
        final app =
            AppNotifier(
                config: AppConfig.dev,
                authSession: AuthSession(storage: MemoryKeyValueStore()),
                productMeasurement: usage,
              )
              ..signedIn = false
              ..status = status;
        await tester.pumpWidget(
          ProviderScope(
            overrides: [appStateProvider.overrideWithValue(app)],
            child: HarnessApp(
              authenticatedScreen: (_) => const SizedBox.shrink(),
            ),
          ),
        );
        await tester.pump(const Duration(milliseconds: 400));
        expect(find.byType(SetupUsageChoice), findsNothing);
        expect(find.text('Share setup and sign-in counts'), findsNothing);
        expect(usage.signedOutSharing, isTrue);
        await captureWindow(tester, capture, 'setup-${status.name}');

        // Deliver the same message as macOS's pre-workspace Settings menu.
        final closed = Completer<void>();
        tester.binding.defaultBinaryMessenger.handlePlatformMessage(
          'harness/app_menu',
          const StandardMethodCodec().encodeMethodCall(
            const MethodCall('settings'),
          ),
          (_) => closed.complete(),
        );
        await tester.pumpAndSettle();
        expect(find.byType(SettingsScreen), findsOneWidget);
        expect(find.text('Share product usage data'), findsOneWidget);
        expect(tester.widget<Switch>(find.byType(Switch)).value, isTrue);
        await tester.tap(find.byType(Switch));
        await tester.pumpAndSettle();
        expect(usage.signedOutSharing, isFalse);
        expect(store.values, {ProductMeasurement.setupPreferenceKey: 'false'});
        await captureWindow(tester, capture, 'privacy-${status.name}-off');
        await tester.tap(find.byKey(const Key('settings-back-button')));
        await tester.pump(const Duration(milliseconds: 100));
        await closed.future;
        expect(find.byType(SettingsScreen), findsNothing);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox.shrink());
        app.dispose();
      },
      variant: TargetPlatformVariant.only(TargetPlatform.macOS),
    );
  }

  testWidgets('failed opt-out save stays off and retries that same choice', (
    tester,
  ) async {
    final store = _FailingWriteStore();
    final usage = ProductMeasurement(
      surface: 'desktop',
      automatic: false,
      setupStorage: store,
      sendSetup: (_) async => {},
    );
    await usage.setupChoiceReady;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: SetupUsageChoice(measurement: usage)),
      ),
    );
    await tester.tap(find.byType(Switch));
    await tester.pumpAndSettle();
    expect(usage.signedOutSharing, isFalse);
    expect(find.textContaining('PRIVATE_CANARY'), findsNothing);
    expect(find.text('Retry saving'), findsOneWidget);
    store.fail = false;
    await tester.tap(find.text('Retry saving'));
    await tester.pumpAndSettle();
    expect(usage.signedOutSharing, isFalse);
    expect(store.values, {ProductMeasurement.setupPreferenceKey: 'false'});
    expect(find.text('Retry saving'), findsNothing);
    await tester.pumpWidget(const SizedBox.shrink());
    usage.dispose();
  });
}
