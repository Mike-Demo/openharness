import 'product_measurement.dart';

/// Mirrors `PRODUCT_USAGE_ONBOARDING_MARKS` in backend/src/types/productUsage.ts, with the steps
/// each is listed under there ([flows]); another pairing would reject the whole report.
enum OnboardingMark {
  /// The step started in an app run that did not sign in: reopened mid-step, not a new start.
  resumed('resumed', {
    ProductFlow.computerWait,
    ProductFlow.sessionOpen,
    ProductFlow.firstMessage,
  }),

  /// "Not you? Sign out" under the account the computer has to sign in to.
  notYou('not_you', {ProductFlow.computerWait}),

  /// The computer's address sent from the phone (share sheet).
  linkShared('link_shared', {ProductFlow.computerWait}),

  /// The joining computer wants its password before its session can open.
  blockedPassword('blocked_password', {ProductFlow.sessionOpen}),

  /// The joining computer is offline, as the account says too.
  blockedOffline('blocked_offline', {ProductFlow.sessionOpen});

  const OnboardingMark(this.wire, this.flows);
  final String wire;
  final Set<ProductFlow> flows;
}

/// The phone's onboarding after sign-in, as fixed flows that hand over to each other: waiting for a
/// computer → opening its session → the first message sent there → the notification prompt.
///
/// Counts and duration buckets only, through [ProductMeasurement]: no account, computer, session,
/// message or answer text, and nothing at all unless the account shares product usage.
///
/// Each flow and each mark counts once per sign-in ([reset] on sign-out). Whatever happens before
/// the account's sharing choice has loaded — right after sign-in — waits here: a step is counted
/// from when it really started once sharing is confirmed, and nothing waiting is counted once the
/// choice reads off. A step that ends before then is never counted; the sign-in itself, which
/// always does, is the exception ([signedIn]).
class OnboardingMeasurement {
  OnboardingMeasurement(this._usage) {
    _usage.addListener(_admit);
  }

  final ProductMeasurement _usage;
  final _waiting = <ProductFlow, ({Stopwatch watch, bool resumed})>{};
  final _running = <ProductFlow, void Function(ProductOutcome)>{};
  final _seen = <ProductFlow>{};
  final _signedIn = <ProductFlow, Duration>{};
  final _marks = <(ProductFlow, OnboardingMark)>{};
  final _marked = <(ProductFlow, OnboardingMark)>{};
  bool _signedInThisRun = false;

  /// A sign-in by [method] went through after [took]. Counted under the account's own sharing — a
  /// far larger group than the signed-out opt-in — as `sign_in` and the button, both ok.
  void signedIn(ProductFlow method, Duration took) {
    _signedInThisRun = true;
    _signedIn[ProductFlow.signIn] = took;
    _signedIn[method] = took;
    _admit();
  }

  /// Starts [flow] the first time it is asked for in this sign-in; build methods may call it on
  /// every frame. Started in an app run that did not sign in, it is counted with
  /// [OnboardingMark.resumed] as well.
  void start(ProductFlow flow) {
    if (!_seen.add(flow)) return;
    _waiting[flow] = (
      watch: Stopwatch()..start(),
      resumed: !_signedInThisRun && OnboardingMark.resumed.flows.contains(flow),
    );
    _admit();
  }

  /// Ends [flow] with [outcome] if it is running; otherwise nothing.
  void end(ProductFlow flow, ProductOutcome outcome) {
    _waiting.remove(flow);
    _running.remove(flow)?.call(outcome);
  }

  /// Counts [what] of [flow], once per sign-in; build methods may call it on every frame. Only for
  /// a step this sign-in has [start]ed — the same screens outside the onboarding count nothing — and
  /// one [what] is listed under.
  void mark(ProductFlow flow, OnboardingMark what) {
    if (!_seen.contains(flow) || !what.flows.contains(flow)) return;
    if (!_marked.add((flow, what))) return;
    _marks.add((flow, what));
    _admit();
  }

  /// Asks the OS for notifications through [ask], counting the answer: allowed is `ok`, refused is
  /// `cancelled`, no answer is `unknown`.
  Future<void> askNotifications(Future<bool?> Function() ask) async {
    start(ProductFlow.notifyPermission);
    final allowed = await ask();
    end(ProductFlow.notifyPermission, switch (allowed) {
      true => ProductOutcome.ok,
      false => ProductOutcome.cancelled,
      null => ProductOutcome.unknown,
    });
  }

  /// Signed out: whatever was still running was abandoned, and the next sign-in starts afresh.
  void reset() {
    for (final flow in [..._running.keys]) {
      end(flow, ProductOutcome.cancelled);
    }
    _clearWaiting();
    _seen.clear();
    _marked.clear();
    _signedInThisRun = false;
  }

  void _clearWaiting() {
    _waiting.clear();
    _signedIn.clear();
    _marks.clear();
  }

  void _admit() {
    if (_usage.declined) return _clearWaiting();
    if (!_usage.sharing) return;
    for (final MapEntry(key: flow, value: step) in [..._waiting.entries]) {
      _waiting.remove(flow);
      _running[flow] = _usage.begin(flow, elapsed: step.watch.elapsed);
      if (step.resumed) _usage.mark(flow, OnboardingMark.resumed.wire);
    }
    for (final MapEntry(key: flow, value: took) in [..._signedIn.entries]) {
      _signedIn.remove(flow);
      _usage.begin(flow, elapsed: took)(ProductOutcome.ok);
    }
    for (final (flow, what) in [..._marks]) {
      _marks.remove((flow, what));
      _usage.mark(flow, what.wire);
    }
  }

  void dispose() {
    _usage.removeListener(_admit);
    _clearWaiting();
    _running.clear();
  }
}
