const config = require('../config');
const db = require('../utils/db');
const validate = require('../utils/payloadValidator');
const express = require('express');
const marked = require('marked');
const xss = require('xss');
const allowedAttrs = ['class', 'id', 'style'];

for (const key of Object.keys(xss.whiteList)) {
  for (const attr of allowedAttrs) {
    if (!xss.whiteList[key].includes(attr)) {
      xss.whiteList[key].push(attr);
    }
  }
}

class Route {
  static async requireSignIn (req, res, next) {
    if (!await req.user.isAuthenticated()) {
      return res.redirect('auth/login');
    }

    next();
  }

  static async checkRejected (req, res, next) {
    this.ensureBotExists(req, res, next, ['bots', 'rejected']);
  }

  static async onlyRejected (req, res, next) {
    this.ensureBotExists(req, res, next, ['rejected']);
  }

  static async ensureBotExists (req, res, next, tables = ['bots']) {
    if (!req.params.id) {
      return res.render('error', { error: 'The ID you provided is invalid' });
    }

    let bot;

    for (const table of tables) {
      bot = await db.table(table).get(req.params.id);

      if (bot) {
        if (table === 'rejected') {
          bot.rejected = true;
        }
        break;
      }
    }

    if (!bot) {
      return res.render('error', { error: 'Bot not found! Did you mistype the ID?' });
    }

    req.bot = bot;
    next();
  }

  static async addPoint (userId, type) {
    const points = await db.table('users')
      .get(userId)(type)
      .default(0)
      .add(1);

    await db.table('users').insert({
      id: userId,
      [type]: points
    }, { conflict: 'update' });
  }

  static async getAdditionalOwners (bot, ids) {
    const owners = [];

    for (const id of ids || []) {
      const u = await bot.fetchUser(id, true); // bool -> cache
      owners.push(u ? `${u.username}#${u.discriminator}` : 'Unknown User#0000');
    }

    return owners.join(', ');
  }

  static configure (server, bot) {
    const router = express.Router();
    server.use('/bot', router);

    router.get('/', (req, res) => {
      res.redirect('/');
    });

    router.get('/:id', this.ensureBotExists, async (req, res) => {
      const { bot: botInfo } = req;

      const currentId = await req.user.id();
      const currentUser = bot.listGuild.members.get(currentId);

      const botOwner = await bot.fetchUser(botInfo.owner)
        || { username: 'Unknown User', discriminator: '0000', id: botInfo.owner };

      botInfo.avatar = bot.getAvatarFor(botInfo.id, botInfo.discriminator);
      botInfo.longDesc = xss(marked(botInfo.longDesc), { css: false, whiteList: { style: [], iframe: ['src', 'class', 'id'], ...xss.whiteList } });
      botInfo.invite = botInfo.invite || `https://discordapp.com/oauth2/authorize?client_id=${botInfo.id}&scope=bot`;
      botInfo.owner = botOwner;
      botInfo.isWebAdmin = currentUser && currentUser.roles.some(id => id === config.management.websiteAdminRole);
      botInfo.canManageBot = currentId && botOwner.id === currentId || botInfo.isWebAdmin;
      botInfo.additionalOwners = await this.getAdditionalOwners(bot, botInfo.additionalOwners);

      res.render('bot', botInfo);
    });

    router.get('/:id/reject', this.ensureBotExists, this.requireSignIn, async (req, res) => {
      const currentUser = bot.listGuild.members.get(await req.user.id());

      if (!currentUser || !currentUser.roles.some(id => id === config.management.websiteAdminRole)) {
        return res.render('error', { error: 'You do not have permission to do that' });
      }

      res.render('reject', { username: req.bot.username });
    });

    router.post('/:id/reject', this.ensureBotExists, this.requireSignIn, async (req, res) => {
      if (!req.body.reason) {
        return res.render('error', { error: 'You need to provide a reason for rejection' });
      }

      const currentUser = bot.listGuild.members.get(await req.user.id());

      if (!currentUser || !currentUser.roles.some(id => id === config.management.websiteAdminRole)) {
        return res.render('error', { error: 'You do not have permission to do that' });
      }

      res.redirect('/queue');
      this.addPoint(currentUser.id, 'rejected');

      const botInfo = await db.getBot(req.bot.id);
      await db.deleteBot(req.bot.id);
      await db.table('rejected').insert({ ...botInfo, reason: `Rejected by ${currentUser.user.username}: ${req.body.reason}` });

      const botMember = bot.listGuild.members.get(req.bot.id);

      if (botMember) {
        try {
          await botMember.kick(`Rejected by ${currentUser.username} for ${req.body.reason}`);
        } catch(e) {
          console.error('Failed to kick while rejecting. The bot may not have the correct permissions.');
        }
      }

      bot.createMessage(config.management.listLogChannel, `${currentUser.username} rejected ${req.bot.username} (<@${req.bot.id}>) for **${req.body.reason}**`);
    });

    router.get('/:id/approve', this.ensureBotExists, this.requireSignIn, async (req, res) => {
      const currentUser = bot.listGuild.members.get(await req.user.id());

      if (!currentUser || !currentUser.roles.some(id => id === config.management.websiteAdminRole)) {
        return res.render('error', { error: 'You do not have permission to do that' });
      }

      const botMember = bot.listGuild.members.get(req.bot.id);

      if (!botMember) {
        return res.render('error', { error: 'The bot needs to be added to AutomaCord\'s server before it can be approved.' });
      }

      res.redirect('/queue');

      this.addPoint(currentUser.id, 'approved');
      await db.table('bots').get(req.bot.id).update({
        approved: true
      });

      const botOwner = bot.listGuild.members.get(req.bot.owner);

      if (botOwner) {
        await botOwner.addRole(config.management.botDeveloperRole, `${currentUser.username} approved ${req.bot.username}`);
      }

      bot.createMessage(config.management.listLogChannel, `${currentUser.username} approved ${req.bot.username} (<@${req.bot.id}>)`);
    });

    router.get('/:id/edit', this.ensureBotExists, this.requireSignIn, async (req, res) => {
      const currentUser = await req.user.id();
      const currentMember = bot.listGuild.members.get(currentUser);

      if (currentUser !== req.bot.owner && (!currentMember || !currentMember.roles.some(id => id === config.management.websiteAdminRole))) {
        return res.render('error', { error: 'You do not have permission to edit this bot' });
      }

      res.render('add', { editing: true, ...req.bot });
    });

    router.post('/:id/edit', this.ensureBotExists, this.requireSignIn, async (req, res) => {
      const validation = validate(req.body, false, res);

      if (!validation) {
        return;
      }

      const currentUser = await req.user.id();
      const currentMember = bot.listGuild.members.get(currentUser);

      if (currentUser !== req.bot.owner && (!currentMember || !currentMember.roles.some(id => id === config.management.websiteAdminRole))) {
        return res.render('error', { error: 'You do not have permission to edit this bot' });
      }

      const { prefix, shortDesc, longDesc, inviteUrl, owners } = req.body;

      await db.table('bots').get(req.bot.id).update({
        invite: inviteUrl,
        prefix,
        shortDesc,
        longDesc,
        additionalOwners: owners.split(' ').filter(e => !!e)
      });

      res.redirect(`/bot/${req.bot.id}`);
      bot.createMessage(config.management.listLogChannel, `${currentMember ? currentMember.username : `<@${currentUser}>`} edited ${req.bot.username} (<@${req.bot.id}>)`);
    });

    router.get('/:id/delete', this.checkRejected.bind(this), this.requireSignIn, async (req, res) => {
      const currentUser = await req.user.id();
      const currentMember = bot.listGuild.members.get(currentUser);

      if (currentUser !== req.bot.owner && (!currentMember || !currentMember.roles.some(id => id === config.management.websiteAdminRole))) {
        return res.render('error', { error: 'You do not have permission to delete this bot' });
      }

      const botMember = bot.listGuild.members.get(req.bot.id);

      if (botMember) {
        try {
          await botMember.kick(`Removed by ${currentMember ? currentMember.name : currentUser}`);
        } catch(e) {
          console.error('Failed to kick while deleting. The bot may not have the correct permissions.');
        }
      }

      if (req.bot.rejected) {
        await db.table('rejected').get(req.bot.id).delete();
      } else {
        await db.table('bots').get(req.bot.id).delete();
      }

      res.redirect('/');

      bot.createMessage(config.management.listLogChannel, `${currentMember ? currentMember.username : `<@${currentUser}>`} deleted ${req.bot.username} (<@${req.bot.id}>)`);
    });

    router.get('/:id/resubmit', this.onlyRejected.bind(this), this.requireSignIn, async (req, res) => {
      const currentUser = await req.user.id();
      const currentMember = bot.listGuild.members.get(currentUser);

      if (currentUser !== req.bot.owner && (!currentMember || !currentMember.roles.some(id => id === config.management.websiteAdminRole))) {
        return res.render('error', { error: 'You do not have permission to resubmit this bot' });
      }

      delete req.bot.rejected;
      delete req.bot.reason;

      await db.table('rejected').get(req.bot.id).delete();
      await db.table('bots').insert(req.bot);

      res.redirect('/mybots');

      bot.createMessage(config.management.listLogChannel, `${currentMember ? currentMember.username : `<@${currentUser}>`} resubmitted ${req.bot.username} (<@${req.bot.id}>)`);
    });
  }
}

module.exports = Route;
