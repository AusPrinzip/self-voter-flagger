'use strict';

const steem = require('steem');
const moment = require('moment');
const wait = require('wait.for');
const lib = require('./lib.js');
const sprintf = require('sprintf-js').sprintf;

function main () {
  // get more information on unhandled promise rejections
  process.on('unhandledRejection', (reason, p) => {
    console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
    // application specific logging, throwing an error, or other logic here
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
    try {
      var headBlock = wait.for(lib.getBlockHeader, lib.getProperties().head_block_number);
      var latestBlockMoment = moment(headBlock.timestamp, moment.ISO_8601);
      // chain stuff
      var rewardFundInfo = wait.for(lib.getRewardFund, 'post');
      console.log('Reward fund info: ' + JSON.stringify(rewardFundInfo));
      var priceInfo = wait.for(lib.getCurrentMedianHistoryPrice);
      console.log('Price info: ' + JSON.stringify(priceInfo));

      var rewardBalance = rewardFundInfo.reward_balance;
      var recentClaims = rewardFundInfo.recent_claims;
      var rewardPool = rewardBalance.replace(' STEEM', '') / recentClaims;

      var sbdPerSteem = priceInfo.base.replace(' SBD', '') / priceInfo.quote.replace(' STEEM', '');

      var steemPerVest = lib.getProperties().total_vesting_fund_steem.replace(' STEEM', '') /
          lib.getProperties().total_vesting_shares.replace(' VESTS', '');

      // var steemMarketData = wait.for(requestJsonFromUrlWrapper, lib.MARKET_VALUE_REQ_URL_STEEM);
      // var sbdMarketData = wait.for(requestJsonFromUrlWrapper, lib.MARKET_VALUE_REQ_URL_SBD);
      // console.log('from ' + lib.MARKET_VALUE_REQ_URL_STEEM + ': ' + JSON.stringify(steemMarketData));
      // console.log('from ' + lib.MARKET_VALUE_REQ_URL_SBD + ': ' + JSON.stringify(sbdMarketData));
      // var steemMarketPrice = steemMarketData[0].price_usd;
      // var sbdMarketPrice = sbdMarketData[0].price_usd;
      // console.log('Market prices: 1 STEEM = US$ ' + steemMarketPrice + ', 1 SBD = US$ ' + sbdMarketPrice);
    } catch (err) {
      console.error(err);
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
      return b.total_extrapolated_roi - a.total_extrapolated_roi;
    });
    var finish = false;
    for (var i = 0; i < flaglist.length; i++) {
      var voterDetails = flaglist[i];
      console.log(' - voter: ' + voterDetails.voter + ' has ' + voterDetails.posts.length + ' recorded posts');

      for (var j = 0; j < voterDetails.posts.length; j++) {
        var postDetails = voterDetails.posts[j];
        console.log(' - - processing post with permlink ' + postDetails.permlink);

        if (postDetails.flagged !== undefined &&
            postDetails.flagged !== null &&
            postDetails.flagged) {
          console.log(' - - already flagged post, continuing...');
          continue;
        }

        // check VP
        var accounts = wait.for(lib.getSteemAccounts, process.env.STEEM_USER);
        lib.setAccount(accounts[0]);
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
        var oneval = ((postDetails.self_vote_payout * 10000 * 52) / (spScaledVests * 100 * rewardPool * sbdPerSteem));
        var votingpower = ((oneval / (100 * vp)) * lib.VOTE_POWER_1_PC) / 100;

        console.log(' - - strength to vote at: ' + votingpower.toFixed(2) + ' %');

        if (votingpower > 100) {
          console.log(' - - - cant vote at ' + votingpower.toFixed(2) + '%, capping at 100%');
          votingpower = 100;
        }

        var percentageInt = parseInt(votingpower.toFixed(2) * lib.VOTE_POWER_1_PC);

        if (percentageInt === 0) {
          console.log(' - - - percentage less than abs(0.01 %), skip.');
          continue;
        }

        // flip sign on percentage to turn into flagger
        percentageInt *= -1;

        console.log(' - - voting...');
        if (process.env.ACTIVE !== undefined &&
            process.env.ACTIVE !== null &&
            process.env.ACTIVE.localeCompare('true') === 0) {
          /*
          try {
            var voteResult = wait.for(steem.broadcast.vote,
              process.env.POSTING_KEY_PRV,
              process.env.STEEM_USER,
              voterDetails.voter,
              postDetails.permlink,
              percentageInt);
            console.log(' - - - vote result: ' + JSON.stringify(voteResult));
            flaglist[i].posts[j].flagged = true;
          } catch (err) {
            console.log(' - - - error voting: ' + JSON.stringify(err));
            console.log(' - - - fatal error, stopping');
            finish = true;
            break;
          }
          console.log(' - - - wait 3.5 seconds to allow vote limit to reset');
          wait.for(lib.timeoutWait, 3500);
          console.log(' - - - finished waiting');
          */
          // comment on post
          var message = 'Your self votes will be countered by @sadkitten for 1 week starting %s because your account is on of the highest self voters. For more details see [this post](https://steemit.com/steemit/@sadkitten/self-voter-return-on-investment-svroi-notoriety-flagging-bot).';
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
          try {
            // TODO : remove this, just for test
            var commentResult = wait.for(steem.broadcast.comment,
              process.env.POSTING_KEY_PRV,
              'roguelike',
              'dv2ea-ignore',
              process.env.STEEM_USER,
              commentPermlink,
              'sadkitten comment',
              commentMsg,
              {});
            /*
            var commentResult = wait.for(steem.broadcast.comment,
              process.env.POSTING_KEY_PRV,
              voterDetails.voter,
              postDetails.permlink,
              process.env.STEEM_USER,
              commentPermlink,
              'sadkitten comment',
              commentMsg,
              {});
              */
            console.log(' - - comment result: ' + JSON.stringify(commentResult));
          } catch (err) {
            console.log(' - - comment posting error: ' + JSON.stringify(err));
          }
          console.log(' - - - Waiting for comment timeout...');
          wait.for(lib.timeoutWait, 20000);
          console.log(' - - - finished waiting');
          // TODO : remove this, just for test
          // *************
          callback();
          return;
          // *************
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
  try {
    var accounts = wait.for(lib.getSteemAccounts, process.env.STEEM_USER);
  } catch (err) {
    console.error(err);
    return 0;
  }
  if (accounts === null || accounts === undefined) {
    console.log('Could not get bot account detail');
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
