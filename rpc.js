const DiscordRPC = require("discord-rpc");
const config = require("./config");
const DISCORD_APP_ID = config.DISCORD_APP_ID;

DiscordRPC.register(DISCORD_APP_ID);
const rpc = new DiscordRPC.Client({ transport: "ipc" });

const startDiscordRPC = async () => {
  if (!DISCORD_APP_ID) {
    console.error("[Discord RPC] DISCORD_APP_ID is not set");
    return;
  }
  rpc.on("ready", () => console.log("[Discord RPC] Ready"));
  await rpc.login({ clientId: DISCORD_APP_ID });
};

const updateDiscordRPC = async ({ name, episode, id }) => {
  let activityDetails = `Watching ${name}`;
  let activityState = `Episode ${episode}`;

  const result = await rpc.setActivity({
    details: activityDetails,
    state: activityState,
    startTimestamp: new Date(),
    largeImageKey: "vumeto",
    largeImageText: "Streaming on Vumeto",
    instance: false,
    ...(id
      ? {
          buttons: [
            {
              label: "Watch Now",
              url: `${config.APP_URL}/watch/${id}?ep=${episode}`,
            },
          ],
        }
      : {}),
  });
  return {
    success: true,
    result,
  };
};

module.exports = {
  startDiscordRPC,
  updateDiscordRPC,
};
