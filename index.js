require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Collection,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder
} = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// === KONSTANTEN ===
const SOURCE_CHANNEL_ID = '1388070050061221990';   // Voralarm-Kanal
const ALARMIERUNG_CHANNEL_ID = '1294270624255971439'; // Einsatz-Details-Kanal
const TARGET_CHANNEL_ID = '1294003170116239431';   // Zielkanal
const NACHALARM_ROLE_ID = '1293999568991555667';

// === SPEICHER ===
const responseTracker = new Collection(); // Voralarme & Nachalarme
const dispatchGroups = new Collection();  // Einsätze (Dispatch numbers)

// === UTILS ===
const matchVoralarmByStichwort = (a, b) => {
  if (!a || !b) return false;
  return a.toLowerCase().includes(b.toLowerCase()) || b.toLowerCase().includes(a.toLowerCase());
};

// === STARTUP ===
client.once('ready', async () => {
  console.log(`✅ Bot ist online als ${client.user.tag}`);

  try {
    const channel = await client.channels.fetch(TARGET_CHANNEL_ID);
    const pinned = await channel.messages.fetchPinned();
    for (const msg of pinned.values()) {
      await msg.unpin();
    }

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('select_startup_alarmtype')
      .setPlaceholder('Nachalarmierung starten...')
      .addOptions(
        new StringSelectMenuOptionBuilder().setLabel('Stiller Alarm').setValue('Stiller Alarm'),
        new StringSelectMenuOptionBuilder().setLabel('Sirenenalarm').setValue('Sirenenalarm')
      );

    const row = new ActionRowBuilder().addComponents(selectMenu);
    const startupMessage = await channel.send({
      content: `Nachalarmierung starten:`,
      components: [row]
    });

    await startupMessage.pin();
    console.log('📌 Startup-Nachalarmierungsnachricht gesendet & gepinnt.');
  } catch (err) {
    console.error('❌ Fehler bei Startup-Nachricht:', err.message);
  }
});

// === VORALARM HANDLER ===
client.on('messageCreate', async (message) => {
  if (message.channel.id !== SOURCE_CHANNEL_ID) return;
  if (message.author.bot && !message.webhookId) return;

  const removePrefix = text =>
    text
      .replace(/Ehrenamt Alarmierung: FF Wiener Neustadt\s*-*\s*/gi, '')
      .replace(/^(\*{1,2}\s*[-–]*\s*)+/g, '')
      .trim();

  let descriptionText = '';
  if (message.content?.trim()) {
    descriptionText = removePrefix(message.content.trim());
  } else if (message.embeds.length > 0) {
    const firstEmbed = message.embeds[0];
    if (firstEmbed.title || firstEmbed.description) {
      descriptionText = [
        firstEmbed.title ? removePrefix(firstEmbed.title) : '',
        firstEmbed.description ? removePrefix(firstEmbed.description) : ''
      ].filter(Boolean).join('\n\n');
    } else descriptionText = '🔗 Nachricht enthält ein eingebettetes Element.';
  } else if (message.attachments.size > 0) {
    const attachment = message.attachments.first();
    descriptionText = `📎 Anhang: ${attachment.name || attachment.url}`;
  } else {
    descriptionText = '⚠️ Kein sichtbarer Nachrichtentext vorhanden.';
  }

  const timestamp = new Date().toLocaleString('de-AT', {
    dateStyle: 'short',
    timeStyle: 'short'
  });

  const embed = new EmbedBuilder()
    .setColor(0xE67E22)
    .setTitle('Ehrenamt Alarmierung: FF Wiener Neustadt')
    .setDescription(`${descriptionText}\n\n${timestamp}`)
    .addFields(
      { name: '✅ Zusagen', value: 'Niemand bisher', inline: true },
      { name: '❌ Absagen', value: 'Niemand bisher', inline: true },
      { name: '🟠 Komme später', value: 'Niemand bisher', inline: true }
    );

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('come_yes').setLabel('✅ Ich komme').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('come_no').setLabel('❌ Ich komme nicht').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('come_late').setLabel('🟠 Ich komme später').setStyle(ButtonStyle.Primary)
  );

  try {
    const targetChannel = await client.channels.fetch(TARGET_CHANNEL_ID);
    const sentMessage = await targetChannel.send({
      embeds: [embed],
      components: [buttons],
      allowedMentions: { parse: [] }
    });

    const plz = descriptionText.match(/\b\d{4,5}\b/)?.[0];
    const stichwort = descriptionText.split(' ')[0] || 'Unbekannt';

    const timeout = setTimeout(async () => {
      try {
        const updated = EmbedBuilder.from(embed)
          .setTitle('⚠️ Keine weiteren Details')
          .setColor(0xffaa00);
        await sentMessage.edit({ embeds: [updated], components: [] });
      } catch (e) {
        console.error('Timeout-Update fehlgeschlagen:', e);
      }
    }, 2 * 60 * 1000);

    responseTracker.set(sentMessage.id, {
      message: sentMessage,
      coming: [],
      notComing: [],
      late: [],
      stichwort,
      plz,
      timeout
    });

    console.log('📢 Voralarm empfangen & gesendet.');
  } catch (err) {
    console.error('❌ Fehler beim Senden:', err.message);
  }
});

// === EINSATZDATEN HANDLER ===
client.on('messageCreate', async (message) => {
  if (message.channel.id !== ALARMIERUNG_CHANNEL_ID) return;
  if (message.author.bot && !message.webhookId) return;
  if (!message.content) return;

  const content = message.content;
  const match = content.match(/Dispatch number:\s*(\d+).*?Alarmcode:\s*(\S+).*?Stichwort:\s*(.+?)\s*\|.*?PLZ:\s*(\d{4,5})(?:.*?Fahrzeug:\s*(.+))?/i);
  if (!match) return;

  const [, dispatchNumber, alarmcode, stichwortRaw, plz, fahrzeugRaw] = match;
  const stichwort = stichwortRaw.trim();
  const fahrzeug = fahrzeugRaw?.trim();

  let einsatz = dispatchGroups.get(dispatchNumber);

  if (!einsatz) {
    // Passenden Voralarm finden
    let matchedVoralarmId;
    for (const [id, entry] of responseTracker) {
      if (!entry.stichwort || !entry.plz) continue;
      if (entry.plz === plz && matchVoralarmByStichwort(entry.stichwort, stichwort)) {
        matchedVoralarmId = id;
        break;
      }
    }

    let embed;
    let messageToEdit;
    if (matchedVoralarmId) {
      const entry = responseTracker.get(matchedVoralarmId);
      clearTimeout(entry.timeout);
      embed = EmbedBuilder.from(entry.message.embeds[0]);
      messageToEdit = entry.message;
      embed.setTitle(`🚒 Einsatz #${dispatchNumber}`);
      responseTracker.delete(matchedVoralarmId);
    } else {
      embed = new EmbedBuilder()
        .setTitle(`🚒 Einsatz #${dispatchNumber}`)
        .setColor(0xff0000);
      const channel = await client.channels.fetch(TARGET_CHANNEL_ID);
      messageToEdit = await channel.send({ embeds: [embed] });
    }

    einsatz = {
      dispatchNumber,
      message: messageToEdit,
      embed,
      fahrzeuge: new Set(),
      coming: [],
      notComing: [],
      late: []
    };
    dispatchGroups.set(dispatchNumber, einsatz);
    setTimeout(() => dispatchGroups.delete(dispatchNumber), 2 * 60 * 60 * 1000);
  }

  if (fahrzeug) einsatz.fahrzeuge.add(fahrzeug);

  const fahrzeugList = Array.from(einsatz.fahrzeuge).join('\n') || '—';

  const updatedEmbed = EmbedBuilder.from(einsatz.embed)
    .setDescription(`**Alarmcode:** ${alarmcode}\n**PLZ:** ${plz}\n**Stichwort:** ${stichwort}`)
    .setFields(
      { name: '🚑 Alarmierte Fahrzeuge', value: fahrzeugList, inline: false },
      { name: '✅ Zusagen', value: einsatz.coming.length ? einsatz.coming.map(id => `<@${id}>`).join('\n') : 'Niemand bisher', inline: true },
      { name: '❌ Absagen', value: einsatz.notComing.length ? einsatz.notComing.map(id => `<@${id}>`).join('\n') : 'Niemand bisher', inline: true },
      { name: '🟠 Komme später', value: einsatz.late.length ? einsatz.late.map(id => `<@${id}>`).join('\n') : 'Niemand bisher', inline: true }
    )
    .setColor(0xff0000);

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`come_yes_${dispatchNumber}`).setLabel('✅ Ich komme').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`come_no_${dispatchNumber}`).setLabel('❌ Ich komme nicht').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`come_late_${dispatchNumber}`).setLabel('🟠 Ich komme später').setStyle(ButtonStyle.Primary)
  );

  await einsatz.message.edit({ embeds: [updatedEmbed], components: [buttons] });
  einsatz.embed = updatedEmbed;
  console.log(`🚒 Einsatz #${dispatchNumber} aktualisiert (${fahrzeug || 'kein neues Fahrzeug'})`);
});

// === BUTTON HANDLER ===
client.on('interactionCreate', async (interaction) => {
  if (interaction.isButton()) {
    const id = interaction.customId;
    const userId = interaction.user.id;
    let entry;

    // Voralarm oder Einsatz?
    if (id.startsWith('come_') && !id.match(/_\d+$/)) {
      entry = responseTracker.get(interaction.message.id);
    } else {
      const dispatchNumber = id.split('_').pop();
      entry = dispatchGroups.get(dispatchNumber);
    }

    if (!entry) return interaction.reply({ content: '⛔ Diese Meldung ist nicht mehr aktiv.', ephemeral: true });

    // Reset user from lists
    entry.coming = entry.coming.filter(u => u !== userId);
    entry.notComing = entry.notComing.filter(u => u !== userId);
    entry.late = entry.late.filter(u => u !== userId);

    if (id.includes('yes')) entry.coming.push(userId);
    if (id.includes('no')) entry.notComing.push(userId);
    if (id.includes('late')) entry.late.push(userId);

    const embed = EmbedBuilder.from(interaction.message.embeds[0]).setFields(
      { name: '✅ Zusagen', value: entry.coming.length ? entry.coming.map(id => `<@${id}>`).join('\n') : 'Niemand bisher', inline: true },
      { name: '❌ Absagen', value: entry.notComing.length ? entry.notComing.map(id => `<@${id}>`).join('\n') : 'Niemand bisher', inline: true },
      { name: '🟠 Komme später', value: entry.late.length ? entry.late.map(id => `<@${id}>`).join('\n') : 'Niemand bisher', inline: true }
    );

    await interaction.message.edit({ embeds: [embed] });
    await interaction.reply({ content: 'Antwort gespeichert 🙌', ephemeral: true });
  }

  // === NACHALARM SELECT + MODAL ===
  if (interaction.isStringSelectMenu() && interaction.customId === 'select_startup_alarmtype') {
    const selected = interaction.values[0];
    const modal = new ModalBuilder().setCustomId('nachalarm_modal').setTitle('Nachalarmierung');

    const stichwort = new TextInputBuilder().setCustomId('stichwort').setLabel('Stichwort').setStyle(TextInputStyle.Short).setRequired(true);
    const adresse = new TextInputBuilder().setCustomId('adresse').setLabel('Adresse').setStyle(TextInputStyle.Short).setRequired(true);
    const info = new TextInputBuilder().setCustomId('info').setLabel('Weitere Infos').setStyle(TextInputStyle.Paragraph);

    modal.addComponents(
      new ActionRowBuilder().addComponents(stichwort),
      new ActionRowBuilder().addComponents(adresse),
      new ActionRowBuilder().addComponents(info)
    );

    interaction.client.alarmType = selected;
    await interaction.showModal(modal);
  }

  if (interaction.isModalSubmit() && interaction.customId === 'nachalarm_modal') {
    const alarmType = interaction.client.alarmType || 'Unbekannt';
    const stichwort = interaction.fields.getTextInputValue('stichwort');
    const adresse = interaction.fields.getTextInputValue('adresse');
    const info = interaction.fields.getTextInputValue('info');

    const embed = new EmbedBuilder()
      .setColor(0xff9900)
      .setTitle(`📣 Nachalarmierung: FF Wiener Neustadt`)
      .setDescription(`**${alarmType}**: ${stichwort}\n📍 ${adresse}\n${info}`)
      .addFields(
        { name: '✅ Zusagen', value: 'Niemand bisher', inline: true },
        { name: '❌ Absagen', value: 'Niemand bisher', inline: true },
        { name: '🟠 Komme später', value: 'Niemand bisher', inline: true }
      );

    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('come_yes').setLabel('✅ Ich komme').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('come_no').setLabel('❌ Ich komme nicht').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('come_late').setLabel('🟠 Ich komme später').setStyle(ButtonStyle.Primary)
    );

    const channel = await client.channels.fetch(TARGET_CHANNEL_ID);
    const sent = await channel.send({
      content: `<@&${NACHALARM_ROLE_ID}>`,
      embeds: [embed],
      components: [buttons],
      allowedMentions: { parse: ['roles'] }
    });

    responseTracker.set(sent.id, {
      message: sent,
      coming: [],
      notComing: [],
      late: []
    });

    await interaction.reply({ content: '✅ Nachalarmierung erfolgreich gesendet.', ephemeral: true });
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
