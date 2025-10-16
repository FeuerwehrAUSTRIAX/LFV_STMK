// dispatcherMatcher.js
const { EmbedBuilder } = require('discord.js');

// Simpler Cache für zuletzt gesendeten Voralarm
let lastPreAlarm = null;

function storePreAlarm(data) {
  lastPreAlarm = data;
}

function tryMatchAndUpdate(realAlarmMessage, client) {
  if (!lastPreAlarm) return;

  const alarmText = realAlarmMessage.content;

  const dispatchMatch = alarmText.match(/Alarm code:\s*(.+)\n.*Postal:\s*(\d{4,5}).*Alarm issue:\s*(.+)/s);
  if (!dispatchMatch) return;

  const [_, alarmCode, postal, issue] = dispatchMatch;

  const isMatch =
    lastPreAlarm?.stichwort?.toLowerCase() === alarmCode.trim().toLowerCase() &&
    lastPreAlarm?.postal?.trim() === postal.trim();

  if (!isMatch) return;

  // Alarmzeit extrahieren oder "jetzt" verwenden
  const now = new Date().toLocaleTimeString('de-AT', {
    hour: '2-digit',
    minute: '2-digit'
  });

  const newEmbed = EmbedBuilder.from(lastPreAlarm.originalEmbed)
    .setTitle(` Alarm für die Feuerwehr Wiener Neustadt um ${now}`)
    .setDescription(`**${alarmCode.trim()}** // Wiener Neustadt-OT\n ${issue.trim()}`);

  return lastPreAlarm.message.edit({ embeds: [newEmbed] });
}

module.exports = {
  storePreAlarm,
  tryMatchAndUpdate
};
