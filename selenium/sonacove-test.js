const { Builder, By, until } = require("selenium-webdriver");

/**
 * Simple Selenium test for Sonacove website
 * 1. Navigate to sonacove.com
 * 2. Click "Get Started Now" button
 * 3. Verify onboarding page is displayed
 */
async function testSonacoveOnboarding(hubUrl = "http://localhost:4444") {
  console.log("🧪 Starting Sonacove onboarding test...");

  let driver;

  try {
    // Create WebDriver instance pointing to Selenium Grid hub
    driver = await new Builder()
      .forBrowser("chrome")
      .usingServer(hubUrl)
      .build();

    console.log("✅ WebDriver connected to grid");

    // Step 1: Navigate to sonacove.com
    console.log("📍 Navigating to sonacove.com...");
    await driver.get("https://sonacove.com");

    // Verify we're on the right page
    const title = await driver.getTitle();
    console.log(`📄 Page title: ${title}`);

    if (!title.includes("Sonacove")) {
      throw new Error("Failed to load Sonacove homepage");
    }

    // Step 2: Find and click "Get Started Now" button
    console.log('🔍 Looking for "Get Started Now" button...');

    // Wait for the button to be present and clickable
    const getStartedButton = await driver.wait(
      until.elementLocated(By.linkText("Get Started Now")),
      10000
    );

    console.log('👆 Clicking "Get Started Now" button...');
    await getStartedButton.click();

    // Step 3: Verify we're on the onboarding page
    console.log("⏳ Waiting for onboarding page to load...");

    // Wait for URL to change to onboarding
    await driver.wait(until.urlContains("/onboarding"), 10000);

    const currentUrl = await driver.getCurrentUrl();
    console.log(`🌐 Current URL: ${currentUrl}`);

    // Verify onboarding page elements
    const welcomeHeading = await driver.wait(
      until.elementLocated(By.css("h1")),
      10000
    );

    const headingText = await welcomeHeading.getText();
    console.log(`📝 Welcome heading: ${headingText}`);

    if (!headingText.includes("Welcome to Sonacove")) {
      throw new Error("Onboarding page heading not found");
    }

    // Look for "Create a new account" link
    const createAccountLink = await driver.findElement(
      By.linkText("Create a new account")
    );
    const isCreateAccountVisible = await createAccountLink.isDisplayed();

    if (!isCreateAccountVisible) {
      throw new Error("Create account link not visible");
    }

    console.log("✅ Test PASSED: Successfully navigated to onboarding page!");

    return {
      success: true,
      message: "Sonacove onboarding test completed successfully",
      url: currentUrl,
      title: await driver.getTitle(),
    };
  } catch (error) {
    console.error("❌ Test FAILED:", error.message);

    // Take a screenshot for debugging (if possible)
    try {
      const screenshot = await driver.takeScreenshot();
      console.log("📸 Screenshot taken for debugging");
      // In a real scenario, you'd save this screenshot
    } catch (screenshotError) {
      console.log("⚠️  Could not take screenshot");
    }

    return {
      success: false,
      error: error.message,
    };
  } finally {
    if (driver) {
      console.log("🔄 Closing browser...");
      await driver.quit();
    }
  }
}

// Export for use in orchestrator
module.exports = { testSonacoveOnboarding };

// Allow running directly for testing
if (require.main === module) {
  const hubUrl = process.argv[2] || "http://localhost:4444";
  testSonacoveOnboarding(hubUrl)
    .then((result) => {
      console.log("🏁 Test result:", result);
      process.exit(result.success ? 0 : 1);
    })
    .catch((error) => {
      console.error("💥 Unexpected error:", error);
      process.exit(1);
    });
}
