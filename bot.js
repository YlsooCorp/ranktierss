require("dotenv").config();
const { Client, GatewayIntentBits, Partials, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, Events } = require("discord.js");
const { createClient } = require("@supabase/supabase-js");
const fetch = require("node-fetch"); // Fixed for CommonJS

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel]
});

const TIERS = ["LT5","HT5","LT4","HT4","LT3","HT3","LT2","HT2","LT1","HT1"];

// Fetch Minecraft UUID by username
async function getMinecraftUUID(username) {
  try {
    const res = await fetch(`https://api.mojang.com/users/profiles/minecraft/${username}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.id;
  } catch (err) {
    console.error("Error fetching Minecraft UUID:", err);
    return null;
  }
}

client.once("ready", () => {
  console.log(`✅ RankTiers Bot Online as ${client.user.tag}`);
});

// ----- Step 1: !rank triggers game select -----
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  const prefix = "!";
  if (!message.content.startsWith(prefix)) return;

  const command = message.content.slice(prefix.length).trim().split(/ +/)[0].toLowerCase();

  if (command === "rank") {
    try {
      const { data: games } = await supabase.from("games").select("*").order("name");
      if (!games || games.length === 0) return message.reply("❌ No games found in the database.");

      const gameRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("rank_select_game")
          .setPlaceholder("Select a game")
          .addOptions(
            games.map(g => ({ label: g.name, value: g.name }))
          )
      );

      await message.reply({ content: "Select a game:", components: [gameRow] });
    } catch (err) {
      console.error(err);
      message.reply("❌ Error fetching games.");
    }
  }
});

// ----- Step 2: Handle selects -----
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;

  try {
    // Game select
    if (interaction.customId === "rank_select_game") {
      const game = interaction.values[0];

      const { data: allStats } = await supabase
        .from("player_stats")
        .select("player_id, points, players(username)")
        .eq("game", game);

      if (!allStats || allStats.length === 0)
        return interaction.update({ content: `❌ No players found for ${game}.`, components: [] });

      const pointsMap = {};
      allStats.forEach(s => {
        const username = s.players?.username || "Unknown";
        if (!pointsMap[username]) pointsMap[username] = 0;
        pointsMap[username] += s.points;
      });

      const sorted = Object.entries(pointsMap)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);

      const playerRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`rank_select_player_${game}`)
          .setPlaceholder("Select a player")
          .addOptions(
            sorted.map(([username, points]) => ({
              label: username,
              description: `${points} points`,
              value: username
            }))
          )
      );

      await interaction.update({ content: `Top 10 players in ${game}:`, components: [playerRow] });
    }

    // Player select
    else if (interaction.customId.startsWith("rank_select_player_")) {
      const game = interaction.customId.replace("rank_select_player_", "");
      const username = interaction.values[0];

      // Fetch player
      const { data: player } = await supabase
        .from("players")
        .select("*")
        .eq("username", username)
        .single();

      if (!player) return interaction.update({ content: `❌ Player ${username} not found.`, components: [] });

      // Fetch stats
      const { data: stats } = await supabase
        .from("player_stats")
        .select("*")
        .eq("player_id", player.id)
        .eq("game", game);

      if (!stats || stats.length === 0)
        return interaction.update({ content: `❌ ${username} has no stats in ${game}.`, components: [] });

      const totalPoints = stats.reduce((sum, s) => sum + s.points, 0);
      const kitsString = stats.map(s => `${s.kit} (${s.tier})`).join(", ");

      // Rank
      const { data: allStats } = await supabase
        .from("player_stats")
        .select("player_id, points")
        .eq("game", game);

      const pointsMap = {};
      allStats.forEach(s => {
        if (!pointsMap[s.player_id]) pointsMap[s.player_id] = 0;
        pointsMap[s.player_id] += s.points;
      });

      const sorted = Object.entries(pointsMap).sort((a, b) => b[1] - a[1]);
      const rank = sorted.findIndex(([id]) => id === player.id) + 1;

      // Minecraft head image
      let headURL = null;
      if (game.toLowerCase() === "minecraft") {
        const uuid = await getMinecraftUUID(username);
        if (uuid) headURL = `https://crafatar.com/avatars/${uuid}?size=128&overlay`;
      }

      // Profile button
      const profileURL = process.env.WEBSITE_URL ? `${process.env.WEBSITE_URL}/profile/${username}` : null;
      const profileButton = new ActionRowBuilder();
      if (profileURL) {
        profileButton.addComponents(
          new ButtonBuilder()
            .setLabel("View Profile")
            .setStyle(ButtonStyle.Link)
            .setURL(profileURL)
        );
      }

      const embed = new EmbedBuilder()
        .setTitle(`${username} — ${game.charAt(0).toUpperCase() + game.slice(1)} Stats`)
        .addFields(
          { name: "Overall Points", value: totalPoints.toString(), inline: true },
          { name: "Kits & Tiers", value: kitsString || "None", inline: false },
          { name: "Rank", value: `#${rank}`, inline: true }
        )
        .setColor("Green")
        .setTimestamp();

      if (headURL) embed.setThumbnail(headURL);

      await interaction.update({ content: `Player details for ${username}:`, components: profileURL ? [profileButton] : [], embeds: [embed] });
    }

  } catch (err) {
    console.error(err);
    interaction.update({ content: "❌ Error processing selection.", components: [] });
  }
});

client.login(process.env.DISCORD_TOKEN);
