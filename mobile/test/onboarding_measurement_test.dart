import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/measurement/onboarding_measurement.dart';
import 'package:harness_mobile/measurement/product_measurement.dart';

void main() {
  late ProductMeasurement usage;
  late OnboardingMeasurement onboarding;
  late List<Map<String, dynamic>> reports;
  late Map<String, dynamic> choice;

  setUp(() {
    reports = [];
    choice = {'enabled': true, 'revision': 0};
    usage = ProductMeasurement(
      surface: 'phone',
      automatic: false,
      now: () => DateTime.utc(2026, 10, 14, 12),
      sendSetup: (r) async => {'accepted': true},
    );
    onboarding = OnboardingMeasurement(usage);
  });
  tearDown(() {
    onboarding.dispose();
    usage.dispose();
  });

  Future<void> signIn() async {
    usage.account(
      'PRIVATE_ACCOUNT',
      choice: () async => choice,
      send: (r) async {
        reports.add(jsonDecode(jsonEncode(r)));
        return {'accepted': true};
      },
    );
    await usage.flush();
  }

  Map<String, dynamic> counters([String prefix = '']) => {
    for (final r in reports)
      for (final MapEntry(:key, :value)
          in (r['counters'] as Map<String, dynamic>).entries)
        if (key.startsWith(prefix)) key: value,
  };

  /// This run's sign-in, which the onboarding's steps follow.
  void signedInHere() =>
      onboarding.signedIn(ProductFlow.signInEmail, Duration.zero);

  test('a step started before sharing loads is counted once it does', () async {
    signedInHere();
    onboarding.start(ProductFlow.computerWait);
    await signIn();
    onboarding.end(ProductFlow.computerWait, ProductOutcome.ok);
    await usage.flush();
    expect(counters('ui_phone_computer_wait_'), {
      'ui_phone_computer_wait_started': 1,
      'ui_phone_computer_wait_ok': 1,
      'ui_phone_computer_wait_under_1s': 1,
    });
  });

  test(
    'a step that ends before sharing is confirmed is never counted',
    () async {
      onboarding.start(ProductFlow.computerWait);
      onboarding.end(ProductFlow.computerWait, ProductOutcome.ok);
      await signIn();
      await usage.flush();
      expect(counters(), isEmpty);
    },
  );

  test('nothing is counted while the account does not share', () async {
    choice = {'enabled': false, 'revision': 1};
    await signIn();
    onboarding.start(ProductFlow.sessionOpen);
    onboarding.end(ProductFlow.sessionOpen, ProductOutcome.ok);
    await usage.flush();
    expect(reports, isEmpty);
  });

  test('each step runs once per sign-in; signing out abandons it', () async {
    await signIn();
    signedInHere();
    onboarding.start(ProductFlow.sessionOpen);
    onboarding.start(ProductFlow.sessionOpen);
    onboarding.reset();
    onboarding.end(ProductFlow.sessionOpen, ProductOutcome.ok);
    signedInHere();
    onboarding.start(ProductFlow.sessionOpen);
    await usage.flush();
    expect(counters('ui_phone_session_open_'), {
      'ui_phone_session_open_started': 2,
      'ui_phone_session_open_cancelled': 1,
      'ui_phone_session_open_under_1s': 1,
    });
  });

  test('the notification answer is an outcome, never more', () async {
    await signIn();
    await onboarding.askNotifications(() async => false);
    await onboarding.askNotifications(() async => true);
    await usage.flush();
    expect(counters(), {
      'ui_phone_notify_permission_started': 1,
      'ui_phone_notify_permission_cancelled': 1,
      'ui_phone_notify_permission_under_1s': 1,
    });
  });

  test('time spent waiting for sharing lands in the duration', () async {
    await signIn();
    usage.begin(ProductFlow.firstMessage, elapsed: const Duration(seconds: 12))(
      ProductOutcome.ok,
    );
    await usage.flush();
    expect(counters()['ui_phone_first_message_10s_to_1m'], 1);
  });

  test(
    'a sign-in counts the total and the button, without identifiers',
    () async {
      await signIn();
      usage.beginEach([ProductFlow.signIn, ProductFlow.signInGoogle])(
        ProductOutcome.ok,
      );
      await usage.flush();
      expect(reports.single.keys.toSet(), {
        'schemaVersion',
        'id',
        'day',
        'counters',
        'revision',
      });
      expect(counters(), {
        'ui_phone_sign_in_started': 1,
        'ui_phone_sign_in_ok': 1,
        'ui_phone_sign_in_under_1s': 1,
        'ui_phone_sign_in_google_started': 1,
        'ui_phone_sign_in_google_ok': 1,
        'ui_phone_sign_in_google_under_1s': 1,
      });
      expect(jsonEncode(reports), isNot(contains('PRIVATE_ACCOUNT')));
    },
  );

  test(
    'a sign-in that went through counts under the account once it shares',
    () async {
      onboarding.signedIn(ProductFlow.signInApple, const Duration(seconds: 3));
      await signIn();
      await usage.flush();
      expect(counters(), {
        'ui_phone_sign_in_started': 1,
        'ui_phone_sign_in_ok': 1,
        'ui_phone_sign_in_1s_to_10s': 1,
        'ui_phone_sign_in_apple_started': 1,
        'ui_phone_sign_in_apple_ok': 1,
        'ui_phone_sign_in_apple_1s_to_10s': 1,
      });
    },
  );

  test(
    'a step reopened in a run that did not sign in is marked resumed',
    () async {
      await signIn();
      onboarding.start(ProductFlow.computerWait);
      onboarding.reset();
      signedInHere();
      onboarding.start(ProductFlow.computerWait);
      await usage.flush();
      expect(counters()['ui_phone_computer_wait_started'], 2);
      expect(counters()['ui_phone_computer_wait_resumed'], 1);
    },
  );

  test(
    'a mark counts once per sign-in, only on a started step it is listed under',
    () async {
      await signIn();
      signedInHere();
      onboarding.mark(ProductFlow.computerWait, OnboardingMark.notYou);
      onboarding.start(ProductFlow.computerWait);
      onboarding.mark(ProductFlow.computerWait, OnboardingMark.notYou);
      onboarding.mark(ProductFlow.computerWait, OnboardingMark.notYou);
      onboarding.mark(ProductFlow.computerWait, OnboardingMark.blockedOffline);
      await usage.flush();
      expect(
        counters().keys.where((k) => k.startsWith('ui_phone_computer_wait_')),
        ['ui_phone_computer_wait_started', 'ui_phone_computer_wait_not_you'],
      );
      expect(counters()['ui_phone_computer_wait_not_you'], 1);
    },
  );

  test('a long step also splits its over_1m', () async {
    await signIn();
    usage.begin(ProductFlow.computerWait, elapsed: const Duration(minutes: 20))(
      ProductOutcome.ok,
    );
    usage.begin(ProductFlow.sessionOpen, elapsed: const Duration(minutes: 20))(
      ProductOutcome.ok,
    );
    await usage.flush();
    expect(counters()['ui_phone_computer_wait_over_1m'], 1);
    expect(counters()['ui_phone_computer_wait_15m_to_1h'], 1);
    expect(counters()['ui_phone_session_open_over_1m'], 1);
    expect(
      counters().keys.where((k) => k.startsWith('ui_phone_session_open_15m')),
      isEmpty,
    );
  });

  test('nothing waiting is counted once the choice reads off', () async {
    choice = {'enabled': false, 'revision': 1};
    onboarding.start(ProductFlow.computerWait);
    onboarding.signedIn(ProductFlow.signInGoogle, Duration.zero);
    await signIn();
    usage.savedChoice({'enabled': true, 'revision': 2});
    onboarding.end(ProductFlow.computerWait, ProductOutcome.ok);
    await usage.flush();
    expect(counters(), isEmpty);
  });

  test('every mark is in the backend vocabulary under each step it names', () {
    final vocabulary = File('../backend/src/types/productUsage.ts')
        .readAsStringSync();
    for (final mark in OnboardingMark.values) {
      for (final flow in mark.flows) {
        final metric = 'ui_phone_${flow.wire}_${mark.wire}';
        expect(vocabulary, contains("'$metric'"), reason: metric);
      }
    }
  });

  test('every flow is in the backend vocabulary', () {
    final vocabulary = File('../backend/src/types/productUsage.ts')
        .readAsStringSync();
    for (final flow in ProductFlow.values) {
      expect(vocabulary, contains("'${flow.wire}'"), reason: flow.wire);
    }
  });
}
