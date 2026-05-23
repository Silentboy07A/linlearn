import { updateMastery, DEFAULT_BKT_PARAMS, type LinuxTopic } from "./bkt";

function runTest() {
  console.log("=== Running Bayesian Knowledge Tracing (BKT) Math Verification ===");

  const topics: LinuxTopic[] = ["navigation", "permissions", "networking"];

  for (const topic of topics) {
    const params = DEFAULT_BKT_PARAMS[topic];
    console.log(`\nTopic: ${topic.toUpperCase()}`);
    console.log(`Prior P(L0): ${params.pL0}`);

    // Test 1: Sequence of 3 correct responses
    let masteryCorrect = params.pL0;
    console.log("Simulating 3 CORRECT responses in a row:");
    for (let i = 1; i <= 3; i++) {
      const prev = masteryCorrect;
      masteryCorrect = updateMastery(masteryCorrect, true, topic);
      console.log(`  Step ${i}: ${prev.toFixed(4)} -> ${masteryCorrect.toFixed(4)} (diff: +${(masteryCorrect - prev).toFixed(4)})`);
    }

    // Test 2: Sequence of 3 incorrect responses
    let masteryIncorrect = params.pL0;
    console.log("Simulating 3 INCORRECT responses in a row:");
    for (let i = 1; i <= 3; i++) {
      const prev = masteryIncorrect;
      masteryIncorrect = updateMastery(masteryIncorrect, false, topic);
      console.log(`  Step ${i}: ${prev.toFixed(4)} -> ${masteryIncorrect.toFixed(4)} (diff: ${(masteryIncorrect - prev).toFixed(4)})`);
    }

    // Sanity checks
    if (masteryCorrect <= params.pL0) {
      throw new Error(`Sanity check failed: P(L) should increase with correct responses.`);
    }
    if (masteryIncorrect >= params.pL0) {
      throw new Error(`Sanity check failed: P(L) should decrease with incorrect responses.`);
    }
  }

  console.log("\n✅ All BKT mathematical sanity checks passed successfully!");
}

try {
  runTest();
} catch (error) {
  console.error("❌ Test execution failed:", error);
  process.exit(1);
}
