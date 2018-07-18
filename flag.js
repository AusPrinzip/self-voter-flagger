'use strict';

const steem = require('steem');
const moment = require('moment');
const wait = require('wait.for');
const lib = require('./lib.js');
const sprintf = require('sprintf-js').sprintf;

const MIN_BOT_SP = 100;
const MIN_VOTINGPOWER_BASE = 0.5; // at 100% VP
const MAX_VOTINGPOWER = 150;

const BOT_ACCOUNTS = process.env.STEEM_USER.split(',');
const BOT_KEYS = process.env.POSTING_KEY_PRV.split(',');

function main () {
  console.log(' *** FLAG.js');
  process.on('unhandledRejection', (reason, p) => {
    console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
    process.exit(1);
  });
  lib.start(function () {
    doProcess(function () {
      console.log('Finished');
      setTimeout(function () {
        process.exit();
      }, 5000);
    });
  });
}

var botlist = [];
var flaglist = [];

function doProcess (callback) {
  wait.launchFiber(function () {
    // set up initial variables
    var latestBlockMoment = getLatestBlockMoment();
    if (latestBlockMoment == null) {
      console.log(' - failed to get latest block moment, exiting');
      callback();
      return;
    }

    var rewardFundInfo = null;
    var tries = 0;
    while (tries < lib.API_RETRIES) {
      tries++;
      try {
        rewardFundInfo = wait.for(lib.getRewardFund, 'post');
        break;
      } catch (err) {
        console.error(err);
        console.log(' - failed to get reward fund info, retrying if possible');
      }
    }
    if (rewardFundInfo === undefined || rewardFundInfo === null) {
      console.log(' - completely failed to get reward fund info, exiting');
      callback();
      return;
    }
    console.log('Reward fund info: ' + JSON.stringify(rewardFundInfo));

    var priceInfo = null;
    tries = 0;
    while (tries < lib.API_RETRIES) {
      tries++;
      try {
        priceInfo = wait.for(lib.getCurrentMedianHistoryPrice);
        break;
      } catch (err) {
        console.error(err);
        console.log(' - failed to get price info, retrying if possible');
      }
    }
    if (priceInfo === undefined || priceInfo === null) {
      console.log(' - completely failed to get price info, exiting');
      callback();
      return;
    }
    console.log('Price info: ' + JSON.stringify(priceInfo));

    var rewardBalance = rewardFundInfo.reward_balance;
    var recentClaims = rewardFundInfo.recent_claims;
    var rewardPool = rewardBalance.replace(' STEEM', '') / recentClaims;

    var sbdPerSteem = priceInfo.base.replace(' SBD', '') / priceInfo.quote.replace(' STEEM', '');

    var steemPerVest = lib.getProperties().total_vesting_fund_steem.replace(' STEEM', '') /
        lib.getProperties().total_vesting_shares.replace(' VESTS', '');

    // get bot account info
    console.log(' - BOT_ACCOUNTS: ' + JSON.stringify(BOT_ACCOUNTS));
    for (var i = 0; i < BOT_ACCOUNTS.length; i++) {
      var botAccount = null;
      tries = 0;
      while (tries < lib.API_RETRIES) {
        tries++;
        try {
          botAccount = wait.for(lib.getSteemAccounts, BOT_ACCOUNTS[i]);
          break;
        } catch (err) {
          console.error(err);
          console.log(' - failed to get bot account' + BOT_ACCOUNTS[i] + ', retrying if possible');
        }
      }
      if (botAccount === undefined || botAccount === null || botAccount.length === 0) {
        console.log(' - completely failed to get bot account' + BOT_ACCOUNTS[i] + ', continuing to next account');
        continue;
      }
      try {
        var sp = lib.getSteemPowerFromVest(
            Number(botAccount[0].vesting_shares.split(' ')[0]) +
            Number(botAccount[0].received_vesting_shares.split(' ')[0]) -
            Number(botAccount[0].delegated_vesting_shares.split(' ')[0]));
        console.log(' - - bot ' + BOT_ACCOUNTS[i] + ' SP: ' + sp);
        if (sp < MIN_BOT_SP) {
          console.log(' - - bot ' + BOT_ACCOUNTS[i] + ' SP too low, skipping');
        } else {
          console.log(' - - bot ' + BOT_ACCOUNTS[i] + ' added to list');
          var bot = {
            bot: BOT_ACCOUNTS[i],
            key: BOT_KEYS[i],
            sp: sp,
            vp: 0
          };
          bot = recalcVotingPowerOfBot(bot, latestBlockMoment);
          botlist.push(bot);
        }
      } catch (err) {
        console.error(err);
        console.log(' - couldnt parse SP for bot account' + BOT_ACCOUNTS[i] + ', continuing to next account');
        continue;
      }
    }
    if (botlist.length === 0) {
      console.log(' - fatal error, no SP in bots, cant vote, exiting');
      callback();
      return;
    }

    // get queue
    console.log('getting flaglist...');
    try {
      flaglist = wait.for(lib.getAllRecordsFromDb, lib.DB_FLAGLIST);
      if (flaglist === undefined || flaglist === null) {
        console.log('cant get flaglist, exiting');
        callback();
        return;
      }
    } catch (err) {
      console.error(err);
      console.log('cant get flaglist, exiting');
      callback();
      return;
    }
    if (flaglist.length === 0) {
      console.log('flaglist is empty, ending flag task');
      callback();
      return;
    }
    flaglist.sort((a, b) => {
      // sort descending
      return b.score - a.score;
    });
    var endTime = moment(new Date()).add(Number(process.env.MAX_MINS_TO_RUN), 'minute');
    var finish = false;
    for (i = 0; i < flaglist.length; i++) {
      var voterDetails = flaglist[i];
      if (voterDetails.posts === undefined ||
          voterDetails.posts == null ||
          voterDetails.posts.length === 0) {
        console.log(' - voter: ' + voterDetails.voter + ' has no recorded posts');
        continue;
      }
      console.log(' - voter: ' + voterDetails.voter + ' has ' + voterDetails.posts.length + ' recorded posts');

      for (var j = 0; j < voterDetails.posts.length; j++) {
        if (moment(new Date()).isAfter(endTime)) {
          console.log('Max time reached, stopping');
          finish = true;
          break;
        }
        var postDetails = voterDetails.posts[j];

        if (postDetails.flagged !== undefined &&
            postDetails.flagged !== null &&
            postDetails.flagged) {
          // console.log(' - - already flagged post, skipping...');
          continue;
        }

        console.log(' - - processing post with permlink ' + postDetails.permlink);

        // check post age
        var content = null;
        tries = 0;
        while (tries < lib.API_RETRIES) {
          tries++;
          try {
            content = wait.for(lib.getPostContent, voterDetails.voter, postDetails.permlink);
            break;
          } catch (err) {
            console.error(err);
            console.log(' - failed to get post content, retrying if possible');
          }
        }
        if (content === undefined || content === null) {
          console.log(' - completely failed to get post content, skipping');
          continue;
        }
        var cashoutTime = moment(content.cashout_time);
        var nowTime = moment(new Date());
        cashoutTime.subtract(7, 'hours');
        if (!nowTime.isBefore(cashoutTime)) {
          console.log(' - - - payout window now closed, mark as flagged but skipping');
          flaglist[i].posts[j].flagged = true;
          continue;
        }

        // check for < 0 rshares
        if (content.net_rshares <= 0) {
          console.log(' - - - already flagged at least to zero (rshares = ' + content.net_rshares + '), mark as flagged but skipping');
          flaglist[i].posts[j].flagged = true;
          continue;
        }

        // check if already voted (can happen that vote was not recorded if script interupted last time)
        var selfVoteRshares = 0;
        var alreadyFlagged = false;
        for (var m = 0; m < content.active_votes.length; m++) {
          if (content.active_votes[m].voter.localeCompare(process.env.STEEM_USER) === 0) {
            console.log(' - - - already flagged this, mark as flagged but skipping');
            flaglist[i].posts[j].flagged = true;
            alreadyFlagged = true;
            break;
          } else if (content.active_votes[m].voter.localeCompare(voterDetails.voter) === 0) {
            selfVoteRshares = content.active_votes[m].rshares;
          }
        }
        if (alreadyFlagged) {
          continue;
        }

        if (selfVoteRshares <= 0) {
          console.log(' - self vote rshares negative or zero (' + selfVoteRshares + '), skipping');
          flaglist[i].posts[j].flagged = true;
          continue;
        }

        // recalcuate post self payout
        var maxPayout = 0;
        var netRshares = 0;
        console.log('content.pending_payout_value: ' + content.pending_payout_value);
        var pendingPayoutValue = content.pending_payout_value.split(' ');
        maxPayout = Number(pendingPayoutValue[0]);
        netRshares = Number(content.net_rshares);
        console.log('netRshares: ' + netRshares);

        var selfVotePayout;
        if (maxPayout <= 0.00) {
          selfVotePayout = 0;
        } else if (content.active_votes.length === 1) {
          console.log(' - - only one voter');
          selfVotePayout = maxPayout;
        } else if (selfVoteRshares >= netRshares) {
          console.log(' - - self vote higher than existing net rshares (indicates already flagged), counter only to remaining amount');
          selfVotePayout = maxPayout;
        } else {
          selfVotePayout = maxPayout * (selfVoteRshares / netRshares);
        }
        console.log('recalculated self vote payout: ' + selfVotePayout);
        if (selfVotePayout < lib.MIN_SELF_VOTE_TO_CONSIDER) {
          console.log(' - self vote too small to consider, skipping');
          flaglist[i].posts[j].flagged = true;
          continue;
        }

        latestBlockMoment = getLatestBlockMoment();
        if (latestBlockMoment == null) {
          console.log(' - failed to get latest block moment, finishing');
          finish = true;
          return;
        }
        // choose which bot to use
        bot = null;
        var maxVotingPower = 0;
        if (botlist.length === 1) {
          bot = botlist[0];
          bot = recalcVotingPower(bot, latestBlockMoment);
          bot = {
            bot: bot.bot,
            key: bot.key,
            vp: bot.vp,
            votingpower: 0
          };
          console.log(' - - VP is at ' + (bot.vp / 100).toFixed(2) + ' %');
          if ((bot.vp / 100).toFixed(2) < Number(process.env.MIN_VP)) {
            console.log(' - - VP less than min of ' + Number(process.env.MIN_VP) + ' %, exiting');
            finish = true; // finish as only one bot with any SP
            break;
          }
          var spScaledVests = bot.sp / steemPerVest;
          var oneval = ((selfVotePayout * 10000 * 52) / (spScaledVests * 100 * rewardPool * sbdPerSteem));
          bot.votingpower = ((oneval / (100 * bot.vp)) * lib.VOTE_POWER_1_PC) / 100;
          bot.votingpower *= 0.85;

          console.log(' - - strength to vote at: ' + bot.votingpower.toFixed(2) + ' %');

          if (bot.votingpower > 100) {
            console.log(' - - - cant vote at ' + bot.votingpower.toFixed(2) + '%, capping at 100%');
            bot.votingpower = 100;
          }
          maxVotingPower = bot.votingpower;
        } else {
          var botlistCleared = [];
          var allBotsUnderVP = true;
          for (var k = 0; k < botlist.length; k++) {
            botlist[k] = recalcVotingPowerOfBot(botlist[k], latestBlockMoment);
            console.log(' - - - ' + botlist[k].bot + ' VP is at ' + (botlist[k].vp / 100).toFixed(2) + ' %');
            if ((botlist[k].vp / 100).toFixed(2) < Number(process.env.MIN_VP)) {
              console.log(' - - VP less than min of ' + Number(process.env.MIN_VP) + ' %, trying next bot');
              continue;
            } else {
              allBotsUnderVP = false;
            }
            spScaledVests = botlist[k].sp / steemPerVest;
            oneval = ((selfVotePayout * 10000 * 52) / (spScaledVests * 100 * rewardPool * sbdPerSteem));
            var votingpower = ((oneval / (100 * botlist[k].vp)) * lib.VOTE_POWER_1_PC) / 100;
            votingpower *= 0.85;
            if (votingpower > maxVotingPower) {
              maxVotingPower = votingpower;
            }
            console.log(' - - strength to vote at: ' + votingpower.toFixed(2) + ' %');
            if (votingpower < (MIN_VOTINGPOWER_BASE * (100 / (botlist[k].vp / 100)))) {
              console.log(' - - vote too small for bot ' + botlist[k].bot + ', skipping consideration');
            } else if (votingpower > MAX_VOTINGPOWER && botlist[k].bot.localeCompare(BOT_ACCOUNTS[0]) !== 0) { // dont apply max condition if is main bot, always keep as fallback
              console.log(' - - vote too large for bot ' + botlist[k].bot + ', skipping consideration');
            } else {
              botlistCleared.push({
                bot: botlist[k].bot,
                key: botlist[k].key,
                vp: botlist[k].vp,
                votingpower: votingpower
              });
            }
          }
          if (allBotsUnderVP) {
            console.log(' - no VP left in any bot, exiting');
            finish = true;
            break;
          }
          bot = null;
          if (botlistCleared.length === 1) {
            console.log(' - - - only one suitable bot found, defaulting to ' + botlistCleared[0].bot);
            bot = botlistCleared[0];
          } else if (botlistCleared.length > 1) {
            botlistCleared.sort(function (a, b) {
              return (100 - a.votingpower) - (100 - b.votingpower);
            });
            // debug logging
            console.log(' - - ordered cleared bot list with votingpower, using first');
            for (m = 0; m < botlistCleared.length; m++) {
              console.log(' - - - ' + botlistCleared[m].bot + ', votingpower = ' + botlistCleared[m].votingpower);
            }
            bot = botlistCleared[0];
          }
        }
        if (bot == null) {
          if (maxVotingPower < 0.01) {
            console.log(' - voting power to cast too small for any bot, marking flagged to skip');
            flaglist[i].posts[j].flagged = true;
          } else {
            console.log(' - couldnt find a bot to use, trying next post to flag');
          }
          continue;
        }

        var percentageInt = parseInt(bot.votingpower.toFixed(2) * lib.VOTE_POWER_1_PC);
        if (percentageInt === 0) {
          console.log(' - - - percentage less than abs(0.01 %), skip (this denotes an error, should have been caught)');
          // flaglist[i].posts[j].flagged = true;
          continue;
        }

        // flip sign on percentage to turn into flagger
        percentageInt *= -1;

        console.log(' - - voting...');
        if (process.env.ACTIVE !== undefined &&
            process.env.ACTIVE !== null &&
            process.env.ACTIVE.localeCompare('true') === 0) {
          var voted = false;
          tries = 0;
          var failedOnHandledError = false;
          while (tries < lib.API_RETRIES) {
            tries++;
            try {
              var voteResult = wait.for(steem.broadcast.vote,
                bot.key,
                bot.bot,
                voterDetails.voter,
                postDetails.permlink,
                percentageInt);
              console.log(' - - - vote result: ' + JSON.stringify(voteResult));
              flaglist[i].posts[j].flagged = true;
              voted = true;
              break;
            } catch (err) {
              // console.log(JSON.stringify(err, null, 2));
              if (err !== undefined &&
                  err.cause !== undefined &&
                  err.cause.data !== undefined &&
                  err.cause.data.name !== undefined &&
                  err.cause.data.name.indexOf('assert_exception') >= 0) {
                console.log(' - assert_exception error!');
                failedOnHandledError = true;
                break;
              }
              wait.for(lib.timeoutWait, 2000);
              console.error(err);
              console.log(' - failed to voter, retrying if possible');
            }
          }
          if (failedOnHandledError) {
            flaglist[i].posts[j].flagged = true;
            console.log(' - - handled error, coninuing');
            continue;
          }
          if (!voted) {
            console.log(' - - - fatal error, stopping');
            finish = true;
            break;
          }
          console.log(' - - - wait 3.5 seconds to allow vote limit to reset');
          wait.for(lib.timeoutWait, 3500);
          console.log(' - - - finished waiting');
          // comment on post
          var message = '@' + voterDetails.voter + ' self votes are being countered by @sadkitten for 1 week starting %s because they are one of the highest self voters of the previous week. For more details see [this post](https://steemit.com/steemit/@sadkitten/self-voter-return-on-investment-svroi-notoriety-flagging-bot).';
          var commentMsg = sprintf(message,
            moment(lib.getLastInfos().update_time, moment.ISO_8601).subtract(Number(process.env.DAYS_UNTIL_UPDATE), 'day').format('dddd, MMMM Do YYYY'));
          console.log('Commenting: ' + commentMsg);
          var commentPermlink = steem.formatter.commentPermlink(voterDetails.voter, postDetails.permlink)
            .toLowerCase()
            .replace('.', '');
          if (commentPermlink.length >= 256) {
            commentPermlink = steem.formatter.commentPermlink(voterDetails.voter, voterDetails.voter + '-sadkitten')
              .toLowerCase()
              .replace('.', '');
          }
          var commented = false;
          tries = 0;
          while (tries < lib.API_RETRIES) {
            tries++;
            try {
              var commentResult = wait.for(steem.broadcast.comment,
                BOT_KEYS[0],
                voterDetails.voter,
                postDetails.permlink,
                BOT_ACCOUNTS[0],
                commentPermlink,
                'sadkitten comment',
                commentMsg,
                {});
              console.log(' - - comment result: ' + JSON.stringify(commentResult));
              commented = true;
              break;
            } catch (err) {
              console.error(err);
              console.log(' - failed to voter, retrying if possible');
            }
          }
          if (!commented) {
            console.log(' - - completely failed to post comment');
          } else {
            console.log(' - - - Waiting for reduced comment timeout...');
            wait.for(lib.timeoutWait, 16500);
            console.log(' - - - finished waiting');
          }
        } else {
          console.log(' - - - bot not in active state, not voting');
        }
      }
      // save updated voter object to flaglist
      wait.for(lib.saveDb, lib.DB_FLAGLIST, flaglist[i]);
      // update on queue if still on queue
      try {
        var queueObj = wait.for(lib.getRecordFromDb, lib.DB_QUEUE, {voter: flaglist[i].voter});
        if (queueObj !== undefined && queueObj !== null) {
          queueObj.posts = flaglist[i].posts;
          wait.for(lib.saveDb, lib.DB_QUEUE, queueObj);
          console.log(' -* saved update obj to queue');
        }
      } catch (err) {
        // nothing
      }
      // update on master voter list
      try {
        var masterVoterObj = wait.for(lib.getRecordFromDb, lib.DB_VOTERS, {voter: flaglist[i].voter});
        if (masterVoterObj !== undefined && masterVoterObj !== null) {
          masterVoterObj.posts = flaglist[i].posts;
          wait.for(lib.saveDb, lib.DB_VOTERS, masterVoterObj);
          console.log(' -* saved update obj to master voter list');
        }
      } catch (err) {
        // nothing
      }
      // finish early if required
      if (finish) {
        break;
      }
    }
    callback();
  });
}

function getLatestBlockMoment () {
  var headBlock = null;
  var tries = 0;
  while (tries < lib.API_RETRIES) {
    tries++;
    try {
      headBlock = wait.for(lib.getBlockHeader, lib.getProperties().head_block_number);
      break;
    } catch (err) {
      console.error(err);
      console.log(' - failed to get head block ' + lib.getProperties().head_block_number + ', retrying if possible');
    }
  }
  if (headBlock === undefined || headBlock === null) {
    console.log(' - completely failed to get head block, exiting');
    return null;
  }
  return moment(headBlock.timestamp, moment.ISO_8601);
}

function recalcVotingPowerOfBot (bot, latestBlockMoment) {
  // update account
  var accounts = null;
  var tries = 0;
  while (tries < lib.API_RETRIES) {
    tries++;
    try {
      accounts = wait.for(lib.getSteemAccounts, bot.bot);
      break;
    } catch (err) {
      console.error(err);
      console.log(' - failed to get account for bot' + bot.bot + ', retrying if possible');
    }
  }
  if (accounts === undefined || accounts === null) {
    console.log(' - completely failed to get bot account, continue without updating it');
    return 0;
  }
  var account = accounts[0];
  bot.vp = recalcVotingPower(account, latestBlockMoment);
  return bot;
}

function recalcVotingPower (account, latestBlockMoment) {
  var vp = account.voting_power;
  var lastVoteTime = moment(account.last_vote_time);
  var secondsDiff = (latestBlockMoment.valueOf() - lastVoteTime.valueOf()) / 1000;
  if (secondsDiff > 0) {
    var vpRegenerated = secondsDiff * 10000 / 86400 / 5;
    vp += vpRegenerated;
  }
  if (vp > 10000) {
    vp = 10000;
  }
  // console.log(' - - new vp(corrected): '+vp);
  return vp;
}

// START THIS SCRIPT
main();
