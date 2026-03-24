'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_FILE      = path.join(__dirname, '..', 'orgchart-data.json');
const CHANGELOG_FILE = path.join(__dirname, '..', 'changelog.json');

function getData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function setData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function getChangelog() {
  try {
    return JSON.parse(fs.readFileSync(CHANGELOG_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}

function appendChangelogEntries(entries) {
  if (!entries.length) return;
  const log = getChangelog();
  log.push(...entries);
  fs.writeFileSync(CHANGELOG_FILE, JSON.stringify(log, null, 2), 'utf8');
}

module.exports = { getData, setData, getChangelog, appendChangelogEntries, DATA_FILE, CHANGELOG_FILE };
