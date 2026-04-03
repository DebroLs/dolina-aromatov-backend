import "dotenv/config";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MINI_APP_URL = process.env.MINI_APP_URL;

if (!TELEGRAM_BOT_TOKEN) {
  throw new Error("TELEGRAM_BOT_TOKEN is missing in .env");
}

if (!MINI_APP_URL) {
  throw new Error("MINI_APP_URL is missing in .env");
}

async function setMenuButton() {
  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setChatMenuButton`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        menu_button: {
          type: "web_app",
          text: "Играть",
          web_app: {
            url: MINI_APP_URL
          }
        }
      })
    }
  );

  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(data.description || "Failed to set menu button");
  }

  console.log("Menu button installed successfully");
  console.log(`Mini App URL: ${MINI_APP_URL}`);
}

void setMenuButton();