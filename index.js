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

const { storePreAlarm, tryMatchAndUpdate } = require('./dispatcherMatcher');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const SOURCE_CHANNEL_ID = '1388070050061221990';
const TARGET_CHANNEL_ID = '1294003170116239431';
const NACHALARM_ROLE_ID = '1293999568991555667';
const ECHTALARM_CHANNEL_ID = '1294270624255971439';

const responseTracker = new Collection();

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
    console.log('📌 Startup-Nachalarmierungsnachricht gesendet und gepinnt.');
  } catch (err) {
    console.error('❌ Fehler bei Startup-Nachricht:', err.message);
  }
});

client.on('messageCreate', async (message) => {
  if (message.channel.id === SOURCE_CHANNEL_ID) {
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
      } else {
        descriptionText = '🔗 Nachricht enthält ein eingebettetes Element.';
      }
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
      .setTitle('📣 Voralarm für die Feuerwehr Wiener Neustadt')
      .setDescription(`Stichwort: ${descriptionText}`)
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

      responseTracker.set(sentMessage.id, {
        message: sentMessage,
        coming: [],
        notComing: [],
        late: []
      });
    } catch (err) {
      console.error('❌ Fehler beim Senden:', err.message);
    }
  }

  // 👉 Echtalarm aus ff-alarmierungen abfangen
  if (message.channel.id === ECHTALARM_CHANNEL_ID) {
    try {
      const updated = await tryMatchAndUpdate(message, client);
      if (updated) {
        console.log('🔁 Voralarm erfolgreich aktualisiert mit Echtalarm.');
      }
    } catch (err) {
      console.error('❌ Fehler beim Echtalarm-Abgleich:', err.message);
    }
  }
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isButton()) {
    const entry = responseTracker.get(interaction.message.id);
    if (!entry) return;

    const userId = interaction.user.id;
    entry.coming = entry.coming.filter(id => id !== userId);
    entry.notComing = entry.notComing.filter(id => id !== userId);
    entry.late = entry.late.filter(id => id !== userId);

    if (interaction.customId === 'come_yes') {
      entry.coming.push(userId);
    } else if (interaction.customId === 'come_no') {
      entry.notComing.push(userId);
    } else if (interaction.customId === 'come_late') {
      entry.late.push(userId);
    }

    const originalEmbed = interaction.message.embeds[0];
    const newEmbed = EmbedBuilder.from(originalEmbed).setFields(
      { name: '✅ Zusagen', value: entry.coming.length > 0 ? entry.coming.map(id => `• <@${id}>`).join('\n') : 'Niemand bisher', inline: true },
      { name: '❌ Absagen', value: entry.notComing.length > 0 ? entry.notComing.map(id => `• <@${id}>`).join('\n') : 'Niemand bisher', inline: true },
      { name: '🟠 Komme später', value: entry.late.length > 0 ? entry.late.map(id => `• <@${id}>`).join('\n') : 'Niemand bisher', inline: true }
    );

    await entry.message.edit({ embeds: [newEmbed] });
    return interaction.reply({ content: 'Antwort gespeichert 🙌', ephemeral: true });
  }

  if (interaction.isStringSelectMenu() && interaction.customId === 'select_startup_alarmtype') {
    const selectedAlarmtype = interaction.values[0];

    const modal = new ModalBuilder()
      .setCustomId('startup_nachalarmieren_modal')
      .setTitle('Nachalarmieren');

    const stichwortInput = new TextInputBuilder().setCustomId('stichwort').setLabel('Stichwort').setStyle(TextInputStyle.Short).setRequired(true);
    const adresseInput = new TextInputBuilder().setCustomId('adresse').setLabel('Postleitzahl').setStyle(TextInputStyle.Short).setRequired(true);
    const infoInput = new TextInputBuilder().setCustomId('info').setLabel('Weitere Infos').setStyle(TextInputStyle.Paragraph).setRequired(false);

    modal.addComponents(
      new ActionRowBuilder().addComponents(stichwortInput),
      new ActionRowBuilder().addComponents(adresseInput),
      new ActionRowBuilder().addComponents(infoInput)
    );

    interaction.client.alarmType = selectedAlarmtype;
    return interaction.showModal(modal);
  }

  if (interaction.isModalSubmit() && interaction.customId === 'startup_nachalarmieren_modal') {
    const alarmtype = interaction.client.alarmType || 'Unbekannt';
    const stichwort = interaction.fields.getTextInputValue('stichwort');
    const adresse = interaction.fields.getTextInputValue('adresse');
    const info = interaction.fields.getTextInputValue('info');

    const embed = new EmbedBuilder()
      .setColor(0xff9900)
      .setTitle('📣 Voralarm für die Feuerwehr Wiener Neustadt')
      .setDescription(`Stichwort: ${stichwort} bei Postleitzahl ${adresse}`)
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
    const sentMessage = await channel.send({
      content: `<@&${NACHALARM_ROLE_ID}>`,
      embeds: [embed],
      components: [buttons],
      allowedMentions: { parse: ['roles'] }
    });

    responseTracker.set(sentMessage.id, {
      message: sentMessage,
      coming: [],
      notComing: [],
      late: []
    });

    storePreAlarm({
      stichwort,
      postal: adresse,
      message: sentMessage,
      originalEmbed: embed
    });

    return interaction.reply({ content: '✅ Nachalarmierung erfolgreich gesendet.', ephemeral: true });
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
