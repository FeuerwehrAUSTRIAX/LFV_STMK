require('dotenv').config();
const { Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Events, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, InteractionType } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel]
});

// === Konstanten / IDs ===
const ID_CHANNEL_ALARM = '1388070050061221990';            // Voralarm-Kanal
const ID_CHANNEL_ALARMIERUNG = '1294270624255971439';      // Detail-/Alarmierungskanal
const ID_CHANNEL_ZIEL = '1294003170116239431';             // Zielkanal, wo gepostet wird
const ID_ROLE_NACHALARM = '1293999568991555667';


// === In-Memory Speicher ===
// Voralarme: Map von Voralarm-ID (z. B. messageId) zu Objekt
const voralarme = new Map(); 
// Dispatch-Gruppen: Map von dispatchNumber zu Objekt
const dispatchGroups = new Map();

// Hilfsfunktion: Buttons für RSVP
function makeRsvpButtons(dispatchNumber = null) {
  // Wenn dispatchNumber null, es ist Voralarm oder Nachalarm — wir kodieren mit customId ohne Nummer
  const yesId = dispatchNumber ? `rsvp_yes_${dispatchNumber}` : `rsvp_yes`;
  const noId  = dispatchNumber ? `rsvp_no_${dispatchNumber}` : `rsvp_no`;
  const laterId = dispatchNumber ? `rsvp_later_${dispatchNumber}` : `rsvp_later`;

  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder().setCustomId(yesId).setLabel('✅ Zusagen').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(noId).setLabel('❌ Absagen').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(laterId).setLabel('🟠 Komme später').setStyle(ButtonStyle.Primary)
    );
  return row;
}

// Hilfs: Update Embed-Felder (RSVP) basierend auf Objekt mit sets
function applyRsvpFields(embed, rsvpObj) {
  // rsvpObj: { yes: Set<userId>, no: Set<userId>, later: Set<userId> }
  embed
    .setFields(
      { name: '✅ Zusagen', value: rsvpObj.yes.size > 0 ? Array.from(rsvpObj.yes).map(u => `<@${u}>`).join('\n') : '—', inline: true },
      { name: '❌ Absagen', value: rsvpObj.no.size > 0 ? Array.from(rsvpObj.no).map(u => `<@${u}>`).join('\n') : '—', inline: true },
      { name: '🟠 Komme später', value: rsvpObj.later.size > 0 ? Array.from(rsvpObj.later).map(u => `<@${u}>`).join('\n') : '—', inline: true }
    );
}

// Hilfs: bereinigen von Voralarm nach Zeit
function scheduleVoralarmCleanup(key, ms = 5 * 60 * 1000) {
  setTimeout(() => {
    if (voralarme.has(key)) {
      const obj = voralarme.get(key);
      // Aktualisiere Embed mit „Keine weiteren Details“ falls noch offen
      if (!obj.closed) {
        const embed = obj.embed;
        embed.setTitle(`⚠️ Keine weiteren Details (PLZ ${obj.plz})`);
        embed.setDescription('…'); // optional
        obj.closed = true;
        obj.message.edit({ embeds: [embed], components: [] }).catch(console.error);
      }
      voralarme.delete(key);
    }
  }, ms);
}

// Hilfs: bereinigen einer Dispatch-Gruppe nach Zeit
function scheduleDispatchCleanup(dispatchNumber, ms = 2 * 60 * 60 * 1000) {
  setTimeout(() => {
    if (dispatchGroups.has(dispatchNumber)) {
      dispatchGroups.delete(dispatchNumber);
    }
  }, ms);
}

// Funktion: Neues Voralarm posten
async function createVoralarm(msg, parsed) {
  const { stichwort, plz, time } = parsed;
  const channel = await client.channels.fetch(ID_CHANNEL_ZIEL);
  const embed = new EmbedBuilder()
    .setTitle(`🚨 Voralarm (PLZ ${plz})`)
    .setDescription(`**Stichwort:** ${stichwort}\n**Zeit:** ${time}`)
    .setColor('Yellow');
  // leere RSVP-Sets
  const rsvpObj = { yes: new Set(), no: new Set(), later: new Set() };
  applyRsvpFields(embed, rsvpObj);
  const row = makeRsvpButtons();

  const sent = await channel.send({ embeds: [embed], components: [row] });
  // Im Speicher merken
  voralarme.set(sent.id, {
    message: sent,
    embed: embed,
    stichwort,
    plz,
    time,
    rsvp: rsvpObj,
    closed: false
  });
  // Cleanup in 5 Minuten
  scheduleVoralarmCleanup(sent.id, 5 * 60 * 1000);
}

// Funktion: Wenn Alarmierungs-Text kommt
async function handleAlarmierung(msg, parsed) {
  const { stichwort, plz, alarmcode, issue, dispatchNumber, fahrzeug } = parsed;

  // Suchen nach existierendem Voralarm, mit match von plz & stichwort oder alarmcode
  let matched = null;
  for (const [key, obj] of voralarme.entries()) {
    if (!obj.closed && obj.plz === plz && obj.stichwort === stichwort) {
      matched = obj;
      break;
    }
  }

  const zielChannel = await client.channels.fetch(ID_CHANNEL_ZIEL);

  if (matched) {
    // Upgrade zu Einsatz – wir behalten die gleiche Nachricht (Embed)
    const obj = matched;
    obj.closed = true;

    const embed = obj.embed
      .setTitle(`🚒 Einsatz #${dispatchNumber}`)
      .setDescription(`**Alarmcode:** ${alarmcode}\n**PLZ:** ${plz}\n**Stichwort / Issue:** ${issue}`)
      .setColor('Orange');

    // Init oder erweitere Dispatch-Gruppe
    let grp = dispatchGroups.get(dispatchNumber);
    if (!grp) {
      // neues
      grp = {
        dispatchNumber,
        message: obj.message,  // wir verwenden dasselbe embed
        embed: embed,
        fahrzeuge: new Set(),
        rsvp: obj.rsvp
      };
      dispatchGroups.set(dispatchNumber, grp);
      scheduleDispatchCleanup(dispatchNumber);
    } else {
      // existierend – wir ersetzen embed und message
      grp.embed = embed;
    }

    // Fahrzeug hinzufügen
    if (fahrzeug) grp.fahrzeuge.add(fahrzeug);

    // Fahrzeugliste-Feld
    const fahrzeugListe = Array.from(grp.fahrzeuge).join('\n');
    embed.addFields({ name: '🚑 Alarmierte Fahrzeuge', value: fahrzeugListe.length > 0 ? fahrzeugListe : '—' });

    // RSVP-Felder
    applyRsvpFields(embed, grp.rsvp);

    // Buttons
    const row = makeRsvpButtons(dispatchNumber);

    await obj.message.edit({ embeds: [embed], components: [row] }).catch(console.error);

    // Entferne den Voralarm aus Map (er ist “geconverted”)
    voralarme.delete(obj.message.id);
  } else {
    // Kein Voralarm gefunden → neuer Einsatz direkt
    const embed = new EmbedBuilder()
      .setTitle(`🚒 Einsatz #${dispatchNumber}`)
      .setDescription(`**Alarmcode:** ${alarmcode}\n**PLZ:** ${plz}\n**Stichwort / Issue:** ${issue}`)
      .setColor('Red');

    const rsvpObj = { yes: new Set(), no: new Set(), later: new Set() };
    applyRsvpFields(embed, rsvpObj);
    const row = makeRsvpButtons(dispatchNumber);

    // send
    const sent = await zielChannel.send({ embeds: [embed], components: [row] });
    // neue Dispatch-Gruppe
    const grp = {
      dispatchNumber,
      message: sent,
      embed: embed,
      fahrzeuge: new Set(fahrzeug ? [fahrzeug] : []),
      rsvp: rsvpObj
    };
    dispatchGroups.set(dispatchNumber, grp);
    scheduleDispatchCleanup(dispatchNumber);
  }
}

// === Nachricht-Listener ===
client.on(Events.MessageCreate, async (msg) => {
  try {
    // Ignoriere Bot-Nachrichten
    if (msg.author.bot) return;

    // Voralarm-Kanal
    if (msg.channelId === ID_CHANNEL_ALARM) {
      // Beispiel: parse: „Ehrenamt Alarmierung: Stichwort PLZ 1234 – 12:34“
      // Du musst das Regex auf dein Format anpassen
      const m = msg.content.match(/(.+?)\s+PLZ\s+(\d{3,5}).*?(\d{1,2}:\d{2})/);
      if (m) {
        const stichwort = m[1].trim();
        const plz = m[2];
        const time = m[3];
        await createVoralarm(msg, { stichwort, plz, time });
      }
    }

    // Alarmierung-Kanal
    else if (msg.channelId === ID_CHANNEL_ALARMIERUNG) {
      // Beispiel: „Dispatch number: 9608 | Alarmcode: A123 | Stichwort: … | PLZ: 1234 | Fahrzeug: Tank 6“
      const m = msg.content.match(/Dispatch number:\s*(\d+).*?Alarmcode:\s*(\S+).*?Stichwort:\s*(.+?)\s*\|.*?PLZ:\s*(\d{3,5})(?:.*?Fahrzeug:\s*(.+))?/);
      if (m) {
        const dispatchNumber = m[1];
        const alarmcode = m[2];
        const stichwort = m[3].trim();
        const plz = m[4];
        const fahrzeug = m[5] ? m[5].trim() : null;
        const issue = stichwort;
        await handleAlarmierung(msg, { stichwort, plz, alarmcode, issue, dispatchNumber, fahrzeug });
      }
    }
  } catch (err) {
    console.error('Fehler beim Verarbeiten einer Nachricht:', err);
  }
});

// === Interaktionen (Buttons / Select / Modal) ===
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isButton()) {
      const cid = interaction.customId;
      // rsvp_yes, rsvp_no, rsvp_later (für Voralarm/Nachalarm) oder mit dispatchNumber
      let base, dispatchNumber;
      const parts = cid.split('_');
      if (parts.length === 2) {
        base = parts[1];  // yes / no / later
      } else if (parts.length === 3) {
        // e.g. rsvp_yes_9608
        base = parts[1];
        dispatchNumber = parts[2];
      } else {
        return;
      }
      const userId = interaction.user.id;

      let grpObj = null;
      if (dispatchNumber) {
        if (!dispatchGroups.has(dispatchNumber)) {
          await interaction.reply({ content: 'Dieser Einsatz existiert nicht mehr bzw. ist abgelaufen.', ephemeral: true });
          return;
        }
        grpObj = dispatchGroups.get(dispatchNumber);
      } else {
        // suche in Voralarm oder Nachalarm — wir müssen den richtigen Eintrag finden, basierend auf Message-Id
        const msgId = interaction.message.id;
        if (voralarme.has(msgId)) {
          grpObj = voralarme.get(msgId);
        } else {
          // unangekannt
        }
      }
      if (!grpObj) {
        await interaction.reply({ content: 'Eintrag nicht gefunden.', ephemeral: true });
        return;
      }

      // Entferne user aus allen Sets
      grpObj.rsvp.yes.delete(userId);
      grpObj.rsvp.no.delete(userId);
      grpObj.rsvp.later.delete(userId);

      if (base === 'yes') grpObj.rsvp.yes.add(userId);
      else if (base === 'no') grpObj.rsvp.no.add(userId);
      else if (base === 'later') grpObj.rsvp.later.add(userId);

      // Embed aktualisieren
      const embed = grpObj.embed;
      applyRsvpFields(embed, grpObj.rsvp);
      const row = makeRsvpButtons(dispatchNumber);

      await interaction.update({ embeds: [embed], components: [row] });
    }

    else if (interaction.isStringSelectMenu()) {
      // für Nachalarm-Select
      if (interaction.customId === 'nachalarm_select') {
        // Auswahl: stumm / sirene
        const val = interaction.values[0]; // "stiller" oder "sirene"
        // Modal öffnen
        const modal = new ModalBuilder()
          .setCustomId(`nachalarm_modal_${val}`)
          .setTitle('Nachalarmierung');

        const stichwortInput = new TextInputBuilder()
          .setCustomId('nach_stichwort')
          .setLabel('Stichwort')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);
        const adresseInput = new TextInputBuilder()
          .setCustomId('nach_adresse')
          .setLabel('Adresse')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);
        const infoInput = new TextInputBuilder()
          .setCustomId('nach_info')
          .setLabel('Weitere Info')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false);

        const row1 = new ActionRowBuilder().addComponents(stichwortInput);
        const row2 = new ActionRowBuilder().addComponents(adresseInput);
        const row3 = new ActionRowBuilder().addComponents(infoInput);
        modal.addComponents(row1, row2, row3);

        await interaction.showModal(modal);
      }
    }

    else if (interaction.type === InteractionType.ModalSubmit) {
      const cid = interaction.customId;
      if (cid.startsWith('nachalarm_modal_')) {
        const mode = cid.split('_').pop(); // "stiller" oder "sirene"
        const stichwort = interaction.fields.getTextInputValue('nach_stichwort');
        const adresse = interaction.fields.getTextInputValue('nach_adresse');
        const info = interaction.fields.getTextInputValue('nach_info');

        const zielChannel = await client.channels.fetch(ID_CHANNEL_ZIEL);
        const embed = new EmbedBuilder()
          .setTitle(`📣 Nachalarmierung: ${stichwort}`)
          .setDescription(`**Adresse:** ${adresse}\n${info ? `**Info:** ${info}` : ''}`)
          .setColor(mode === 'sirene' ? 'DarkRed' : 'Blue');

        const rsvpObj = { yes: new Set(), no: new Set(), later: new Set() };
        applyRsvpFields(embed, rsvpObj);
        const row = makeRsvpButtons();

        const ping = `<@&${ID_ROLE_NACHALARM}>`;
        await zielChannel.send({ content: ping, embeds: [embed], components: [row] });

        await interaction.reply({ content: 'Nachalarmierung gesendet.', ephemeral: true });
      }
    }

  } catch (err) {
    console.error('Fehler bei Interaction:', err);
  }
});

// Beim Start: Nachalarm-Message und Pinnen
client.once(Events.ClientReady, async () => {
  console.log(`Bot ist eingeloggt als ${client.user.tag}`);

  const channel = await client.channels.fetch(ID_CHANNEL_ZIEL);
  // Baue das Select-Menü
  const select = new StringSelectMenuBuilder()
    .setCustomId('nachalarm_select')
    .setPlaceholder('Nachalarm starten …')
    .addOptions([
      { label: 'Stiller Alarm', value: 'stiller' },
      { label: 'Sirenenalarm', value: 'sirene' }
    ]);
  const row = new ActionRowBuilder().addComponents(select);

  // sende Nachricht
  const sent = await channel.send({ content: 'Nachalarmierung starten:', components: [row] });
  // pinnen
  await sent.pin().catch(console.error);
});

// Login
client.login(process.env.DISCORD_BOT_TOKEN).catch(err => {
  console.error('Login fehlgeschlagen:', err);
});
