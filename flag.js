'use strict';

const steem = require('steem');
const moment = require('moment');
const wait = require('wait.for');
const lib = require('./lib.js');
const sprintf = require('sprintf-js').sprintf;

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

var flaglist = [];

function doProcess (callback) {
  wait.launchFiber(function () {
    // set up initial variables
    console.log('Getting blockchain info');
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
      callback();
      return;
    }
    var latestBlockMoment = moment(headBlock.timestamp, moment.ISO_8601);

    var rewardFundInfo = null;
    tries = 0;
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
    for (var i = 0; i < flaglist.length; i++) {
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

        // check VP
        var vp = recalcVotingPower(latestBlockMoment);
        console.log(' - - VP is at ' + (vp / 100).toFixed(2) + ' %');
        if ((vp / 100).toFixed(2) < Number(process.env.MIN_VP)) {
          console.log(' - - VP less than min of ' + Number(process.env.MIN_VP) + ' %, exiting');
          finish = true;
          break;
        }

        var vestingSharesParts = lib.getAccount().vesting_shares.split(' ');
        var vestingSharesNum = Number(vestingSharesParts[0]);
        var receivedSharesParts = lib.getAccount().received_vesting_shares.split(' ');
        var receivedSharesNum = Number(receivedSharesParts[0]);
        var delegatedSharesParts = lib.getAccount().delegated_vesting_shares.split(' ');
        var delegatedSharesNum = Number(delegatedSharesParts[0]);
        var totalVests = vestingSharesNum + receivedSharesNum - delegatedSharesNum;

        var steempower = lib.getSteemPowerFromVest(totalVests);
        // console.log('steem power: ' + steempower);
        var spScaledVests = steempower / steemPerVest;
        var oneval = ((selfVotePayout * 10000 * 52) / (spScaledVests * 100 * rewardPool * sbdPerSteem));
        var votingpower = ((oneval / (100 * vp)) * lib.VOTE_POWER_1_PC) / 100;

        console.log(' - - strength to vote at: ' + votingpower.toFixed(2) + ' %');

        if (votingpower > 100) {
          console.log(' - - - cant vote at ' + votingpower.toFixed(2) + '%, capping at 100%');
          votingpower = 100;
        }

        votingpower *= 0.85;

        console.log(' - - modifying vote percentage to 85% of full power counter, resulting at ' + votingpower);

        var percentageInt = parseInt(votingpower.toFixed(2) * lib.VOTE_POWER_1_PC);

        if (percentageInt === 0) {
          console.log(' - - - percentage less than abs(0.01 %), skip.');
          flaglist[i].posts[j].flagged = true;
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
          while (tries < lib.API_RETRIES) {
            tries++;
            try {
              var voteResult = wait.for(steem.broadcast.vote,
                process.env.POSTING_KEY_PRV,
                process.env.STEEM_USER,
                voterDetails.voter,
                postDetails.permlink,
                percentageInt);
              console.log(' - - - vote result: ' + JSON.stringify(voteResult));
              flaglist[i].posts[j].flagged = true;
              voted = true;
              break;
            } catch (err) {
              console.error(err);
              console.log(' - failed to voter, retrying if possible');
            }
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
            moment(lib.getLastInfos().update_time, moment.ISO_8601).subtract(Number(process.env.DAYS_UNTIL_UPDATE), 'day').format('dddd, MMMM Do YYYY, h:mm'));
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
          var failedOnHandledError = false;
          while (tries < lib.API_RETRIES) {
            tries++;
            try {
              var commentResult = wait.for(steem.broadcast.comment,
                process.env.POSTING_KEY_PRV,
                voterDetails.voter,
                postDetails.permlink,
                process.env.STEEM_USER,
                commentPermlink,
                'sadkitten comment',
                commentMsg,
                {});
              console.log(' - - comment result: ' + JSON.stringify(commentResult));
              commented = true;
              break;
            } catch (err) {
              JSON.stringify(err);
              if (err !== undefined &&
                  err.indexOf('assert_exception') >= 0) {
                console.log(' - assert_exception error!');
                failedOnHandledError = true;
                break;
              }
              // console.error(err);
              console.log(' - failed to voter, retrying if possible');
              wait.for(lib.timeoutWait, 2000);
            }
          }
          if (failedOnHandledError) {
            flaglist[i].posts[j].flagged = true;
            console.log(' - - handled error, coninuing');
            continue;
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

function recalcVotingPower (latestBlockMoment) {
  // update account
  var accounts = null;
  var tries = 0;
  while (tries < lib.API_RETRIES) {
    tries++;
    try {
      accounts = wait.for(lib.getSteemAccounts, process.env.STEEM_USER);
      break;
    } catch (err) {
      console.error(err);
      console.log(' - failed to get account for bot, retrying if possible');
    }
  }
  if (accounts === undefined || accounts === null) {
    console.log(' - completely failed to get bot account, continue without updating it');
    return 0;
  }
  var account = accounts[0];
  lib.setAccount(accounts[0]);
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
