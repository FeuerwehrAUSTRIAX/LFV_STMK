require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  InteractionType
} = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

// === KONSTANTEN ===
const ID_CHANNEL_ALARM = '1388070050061221990';            // Voralarm-Kanal
const ID_CHANNEL_ALARMIERUNG = '1294270624255971439';      // Detail-/Alarmierungskanal
const ID_CHANNEL_ZIEL = '1294003170116239431';             // Zielkanal
const ID_ROLE_NACHALARM = '1293999568991555667';

// === IN-MEMORY MAPS ===
const voralarme = new Map(); // Voralarm-ID -> Objekt
const dispatchGroups = new Map(); // Dispatch number -> Objekt

// === HILFSFUNKTIONEN ===
function makeRsvpButtons(dispatchNumber = null) {
  const yesId = dispatchNumber ? `rsvp_yes_${dispatchNumber}` : `rsvp_yes`;
  const noId = dispatchNumber ? `rsvp_no_${dispatchNumber}` : `rsvp_no`;
  const laterId = dispatchNumber ? `rsvp_later_${dispatchNumber}` : `rsvp_later`;

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(yesId).setLabel('✅ Zusagen').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(noId).setLabel('❌ Absagen').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(laterId).setLabel('🟠 Komme später').setStyle(ButtonStyle.Primary)
  );
}

function applyRsvpFields(embed, rsvpObj) {
  embed.setFields(
    { name: '✅ Zusagen', value: rsvpObj.yes.size ? Array.from(rsvpObj.yes).map(u => `<@${u}>`).join('\n') : '—', inline: true },
    { name: '❌ Absagen', value: rsvpObj.no.size ? Array.from(rsvpObj.no).map(u => `<@${u}>`).join('\n') : '—', inline: true },
    { name: '🟠 Komme später', value: rsvpObj.later.size ? Array.from(rsvpObj.later).map(u => `<@${u}>`).join('\n') : '—', inline: true }
  );
}

function scheduleVoralarmCleanup(key, ms = 5 * 60 * 1000) {
  setTimeout(() => {
    const obj = voralarme.get(key);
    if (obj && !obj.closed) {
      obj.embed.setTitle(`⚠️ Keine weiteren Details (PLZ ${obj.plz})`);
      obj.closed = true;
      obj.message.edit({ embeds: [obj.embed], components: [] }).catch(console.error);
      voralarme.delete(key);
    }
  }, ms);
}

function scheduleDispatchCleanup(dispatchNumber, ms = 2 * 60 * 60 * 1000) {
  setTimeout(() => {
    dispatchGroups.delete(dispatchNumber);
  }, ms);
}

// === VORALARM ANLEGEN ===
async function createVoralarm(msg, { stichwort, plz, time }) {
  const embed = new EmbedBuilder()
    .setTitle(`🚨 Voralarm (PLZ ${plz})`)
    .setDescription(`**Stichwort:** ${stichwort}\n**Zeit:** ${time}`)
    .setColor('Yellow');

  const rsvpObj = { yes: new Set(), no: new Set(), later: new Set() };
  applyRsvpFields(embed, rsvpObj);
  const row = makeRsvpButtons();

  const zielChannel = await client.channels.fetch(ID_CHANNEL_ZIEL);
  const sent = await zielChannel.send({ embeds: [embed], components: [row] });

  voralarme.set(sent.id, {
    message: sent,
    embed,
    stichwort,
    plz,
    rsvp: rsvpObj,
    closed: false
  });

  scheduleVoralarmCleanup(sent.id);
}

// === ALARMIERUNG VERARBEITEN ===
async function handleAlarmierung(msg, { stichwort, plz, alarmcode, issue, dispatchNumber, fahrzeug }) {
  const zielChannel = await client.channels.fetch(ID_CHANNEL_ZIEL);

  let matched = null;
  for (const [_, obj] of voralarme.entries()) {
    if (!obj.closed && obj.plz === plz && obj.stichwort === stichwort) {
      matched = obj;
      break;
    }
  }

  if (matched) {
    matched.closed = true;
    voralarme.delete(matched.message.id);

    const embed = matched.embed
      .setTitle(`🚒 Einsatz #${dispatchNumber}`)
      .setDescription(`**Alarmcode:** ${alarmcode}\n**PLZ:** ${plz}\n**Stichwort / Issue:** ${issue}`)
      .setColor('Orange');

    const fahrzeuge = new Set();
    if (fahrzeug) fahrzeuge.add(fahrzeug);

    const grp = {
      dispatchNumber,
      message: matched.message,
      embed,
      fahrzeuge,
      rsvp: matched.rsvp
    };
    dispatchGroups.set(dispatchNumber, grp);
    scheduleDispatchCleanup(dispatchNumber);

    embed.addFields({ name: '🚑 Alarmierte Fahrzeuge', value: fahrzeug });
    applyRsvpFields(embed, grp.rsvp);
    const row = makeRsvpButtons(dispatchNumber);

    await matched.message.edit({ embeds: [embed], components: [row] });
  } else {
    const embed = new EmbedBuilder()
      .setTitle(`🚒 Einsatz #${dispatchNumber}`)
      .setDescription(`**Alarmcode:** ${alarmcode}\n**PLZ:** ${plz}\n**Stichwort / Issue:** ${issue}`)
      .setColor('Red');

    const rsvpObj = { yes: new Set(), no: new Set(), later: new Set() };
    const fahrzeuge = new Set();
    if (fahrzeug) fahrzeuge.add(fahrzeug);

    embed.addFields({ name: '🚑 Alarmierte Fahrzeuge', value: fahrzeug || '—' });
    applyRsvpFields(embed, rsvpObj);
    const row = makeRsvpButtons(dispatchNumber);

    const sent = await zielChannel.send({ embeds: [embed], components: [row] });

    dispatchGroups.set(dispatchNumber, {
      dispatchNumber,
      message: sent,
      embed,
      fahrzeuge,
      rsvp: rsvpObj
    });
    scheduleDispatchCleanup(dispatchNumber);
  }
}

// === STARTUP: Nachalarmierungs-Nachricht + PIN ===
client.once(Events.ClientReady, async () => {
  console.log(`✅ Bot ist online als ${client.user.tag}`);
  const channel = await client.channels.fetch(ID_CHANNEL_ZIEL);

  const select = new StringSelectMenuBuilder()
    .setCustomId('nachalarm_select')
    .setPlaceholder('Nachalarmierung starten …')
    .addOptions(
      { label: 'Stiller Alarm', value: 'stiller' },
      { label: 'Sirenenalarm', value: 'sirene' }
    );

  const row = new ActionRowBuilder().addComponents(select);
  const sent = await channel.send({ content: 'Nachalarmierung starten:', components: [row] });
  await sent.pin();
});

// === MESSAGE HANDLER ===
client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot) return;

  if (msg.channelId === ID_CHANNEL_ALARM) {
    const m = msg.content.match(/(.+?)\s+PLZ\s+(\d{4,5}).*?(\d{1,2}:\d{2})/);
    if (m) {
      const [_, stichwort, plz, time] = m;
      await createVoralarm(msg, { stichwort, plz, time });
    }
  }

  if (msg.channelId === ID_CHANNEL_ALARMIERUNG) {
    const m = msg.content.match(/Dispatch number:\s*(\d+).*?Alarmcode:\s*(\S+).*?Stichwort:\s*(.+?)\s*\|.*?PLZ:\s*(\d{4,5})(?:.*?Fahrzeug:\s*(.+))?/);
    if (m) {
      const [_, dispatchNumber, alarmcode, stichwort, plz, fahrzeug] = m;
      await handleAlarmierung(msg, { dispatchNumber, alarmcode, stichwort, plz, issue: stichwort, fahrzeug });
    }
  }
});

// === INTERACTION HANDLER ===
client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton()) {
    const cid = interaction.customId;
    const [_, type, dispatchNumber] = cid.split('_');
    const userId = interaction.user.id;

    let obj = dispatchNumber
      ? dispatchGroups.get(dispatchNumber)
      : voralarme.get(interaction.message.id);

    if (!obj) {
      await interaction.reply({ content: '⛔ Ungültige oder abgelaufene Nachricht.', ephemeral: true });
      return;
    }

    obj.rsvp.yes.delete(userId);
    obj.rsvp.no.delete(userId);
    obj.rsvp.later.delete(userId);

    if (type === 'yes') obj.rsvp.yes.add(userId);
    if (type === 'no') obj.rsvp.no.add(userId);
    if (type === 'later') obj.rsvp.later.add(userId);

    applyRsvpFields(obj.embed, obj.rsvp);
    const row = makeRsvpButtons(dispatchNumber);
    await interaction.update({ embeds: [obj.embed], components: [row] });
  }

  if (interaction.isStringSelectMenu() && interaction.customId === 'nachalarm_select') {
    const mode = interaction.values[0]; // "stiller" oder "sirene"
    const modal = new ModalBuilder()
      .setCustomId(`nachalarm_modal_${mode}`)
      .setTitle('Nachalarmierung');

    const stichwort = new TextInputBuilder().setCustomId('nach_stichwort').setLabel('Stichwort').setStyle(TextInputStyle.Short).setRequired(true);
    const adresse = new TextInputBuilder().setCustomId('nach_adresse').setLabel('Adresse').setStyle(TextInputStyle.Short).setRequired(true);
    const info = new TextInputBuilder().setCustomId('nach_info').setLabel('Weitere Info').setStyle(TextInputStyle.Paragraph).setRequired(false);

    const modalRows = [stichwort, adresse, info].map(component => new ActionRowBuilder().addComponents(component));
    modal.addComponents(...modalRows);
    await interaction.showModal(modal);
  }

  if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith('nachalarm_modal_')) {
    const mode = interaction.customId.split('_').pop();
    const stichwort = interaction.fields.getTextInputValue('nach_stichwort');
    const adresse = interaction.fields.getTextInputValue('nach_adresse');
    const info = interaction.fields.getTextInputValue('nach_info');

    const embed = new EmbedBuilder()
      .setTitle(`📣 Nachalarmierung: ${stichwort}`)
      .setDescription(`**Adresse:** ${adresse}\n${info ? `**Info:** ${info}` : ''}`)
      .setColor(mode === 'sirene' ? 'DarkRed' : 'Blue');

    const rsvpObj = { yes: new Set(), no: new Set(), later: new Set() };
    applyRsvpFields(embed, rsvpObj);
    const row = makeRsvpButtons();

    const zielChannel = await client.channels.fetch(ID_CHANNEL_ZIEL);
    await zielChannel.send({
      content: `<@&${ID_ROLE_NACHALARM}>`,
      embeds: [embed],
      components: [row],
      allowedMentions: { parse: ['roles'] }
    });

    await interaction.reply({ content: '✅ Nachalarmierung gesendet.', ephemeral: true });
  }
});

// === LOGIN ===
client.login(process.env.DISCORD_BOT_TOKEN).catch(err => {
  console.error('Login fehlgeschlagen:', err);
});
