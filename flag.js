'use strict';

const steem = require('steem');
// const path = require('path');
// const mongodb = require('mongodb');
const moment = require('moment');
// const S = require('string');
const wait = require('wait.for');
const lib = require('./lib.js');

// const MAX_ITERATIONS = 50;

function main () {
  lib.start(function () {
    doProcess(function () {
      console.log('Finished');
      setTimeout(function () {
        process.exit();
      }, 5000);
    });
  });
}

function doProcess (callback) {
  wait.launchFiber(function () {
    // get some info first
    var headBlock = wait.for(lib.steem_getBlockHeader_wrapper, lib.getProperties().head_block_number);
    var latestBlockMoment = moment(headBlock.timestamp, moment.ISO_8601);
    // chain stuff
    var rewardFundInfo = wait.for(lib.steem_getRewardFund_wrapper, 'post');
    var priceInfo = wait.for(lib.steem_getCurrentMedianHistoryPrice_wrapper);

    var rewardBalance = rewardFundInfo.reward_balance;
    var rewardClaims = rewardFundInfo.recent_claims;
    var rewardPool = rewardBalance.replace(' STEEM', '') / rewardClaims;

    var sbdPerSteem = priceInfo.base.replace(' SBD', '') / priceInfo.quote.replace(' STEEM', '');

    var steemPerVest = lib.getProperties().total_vesting_fund_steem.replace(' STEEM', '') /
      lib.getProperties().total_vesting_shares.replace(' VESTS', '');

    // get queue and sort largest self vote payout first
    var queue = wait.for(lib.getAllQueue);
    if (queue === undefined || queue === null || queue.length === 0) {
      console.log('Nothing in queue! Exiting');
      callback();
      return;
    }
    queue.sort(function (a, b) {
      return b.total_extrapolated_roi - a.total_extrapolated_roi;
    });

    for (var k = 0; k < queue[0].comments.length; k++) {
      // process ONE item
      var voter = queue[0].voter;
      var item = queue[0].comments[k];

      console.log('** processing for user: ' + voter);

      // check payout window still open (only when active)
      if (process.env.ACTIVE !== undefined &&
        process.env.ACTIVE !== null &&
        process.env.ACTIVE.localeCompare('true') === 0) {
        var content = wait.for(lib.steem_getContent_wrapper, voter,
          item.permlink);
        if (content === undefined || content === null) {
          console.log('Couldnt get content, assuming is within payout' +
            ' window');
        } else {
          var cashoutTime = moment(content.cashout_time);
          cashoutTime.subtract(7, 'hours');
          var nowTime = moment(new Date());
          if (!nowTime.isBefore(cashoutTime)) {
            console.log('payout window now closed, remove from queue and' +
              ' move on :(');
            continue;
          }
        }
      }

      // TODO : reject if item.self_vote_payout < some min

      // calculate voting percentage for vote
      // first update account
      var accounts = wait.for(lib.steem_getAccounts_wrapper, process.env.STEEM_USER);
      lib.setAccount(accounts[0]);
      var vp = recalcVotingPower(latestBlockMoment);

      console.log('\n - VP is at ' + (vp / 100).toFixed(2) + ' %');
      if ((vp / 100).toFixed(2) < Number(process.env.MIN_VP)) {
        console.log('\n - - VP less than min of ' + Number(process.env.MIN_VP) + ' %, exiting');
        // TODO : keep this?
        // skipToFinish = true;
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
      var oneval = ((item.self_vote_payout * 10000 * 52) / (spScaledVests * 100 * rewardPool * sbdPerSteem));
      var votingpower = ((oneval / (100 * vp)) * lib.VOTE_POWER_1_PC) / 100;

      console.log('\n - strength to vote at: ' + votingpower.toFixed(2) + ' %');

      if (votingpower > 100) {
        console.log('\n - cant vote at ' + votingpower.toFixed(2) + '%, capping at 100%');
        votingpower = 100;
      }

      var percentageInt = parseInt(votingpower.toFixed(2) * lib.VOTE_POWER_1_PC);

      if (percentageInt === 0) {
        console.log('\n - percentage less than abs(0.01 %), skip.');
        continue;
      }

      // flip sign on percentage to turn into flagger
      percentageInt *= -1;

      console.log('\n - voting...');
      if (process.env.ACTIVE !== undefined &&
          process.env.ACTIVE !== null &&
          process.env.ACTIVE.localeCompare('true') === 0) {
        try {
          var voteResult = wait.for(steem.broadcast.vote,
            process.env.POSTING_KEY_PRV,
            process.env.STEEM_USER,
            voter,
            item.permlink,
            percentageInt);
          console.log('Vote result: ' + JSON.stringify(voteResult));
        } catch (err) {
          console.log('Error voting: ' + JSON.stringify(err));
          callback();
          return;
        }
        console.log('\n - - wait 3.5 seconds to allow vote limit to reset');
        wait.for(lib.timeoutWait, 3500);
        console.log('\n - - - finished waiting');
      } else {
        console.log('\n - - bot not in active state, not voting');
      }



      // OLD STUFF, REMOVE



      console.log('** processing item ' + k + ': ' + JSON.stringify(item));
      // update account
      var accounts = wait.for(lib.steem_getAccounts_wrapper, process.env.STEEM_USER);
      lib.setAccount(accounts[0]);
      console.log('--DEBUG CALC VOTE PERCENTAGE--');
      var vp = recalcVotingPower(latestBlockMoment);
      console.log(' - vp: ' + vp);
      console.log(' - abs_percentage calc');
      console.log(' - - mAccount.vesting_shares: ' + lib.getAccount().vesting_shares);
      console.log(' - - mAccount.received_vesting_shares' +
        ' (delegated from others): ' + lib.getAccount().received_vesting_shares);
      var vestingSharesParts = lib.getAccount().vesting_shares.split(' ');
      var vestingSharesNum = Number(vestingSharesParts[0]);
      console.log(' - - - vesting_shares num: ' + vestingSharesNum);
      var receivedSharesParts = lib.getAccount().received_vesting_shares.split(' ');
      var receivedSharesNum = Number(receivedSharesParts[0]);
      console.log(' - - - received_vesting_shares num: ' + receivedSharesNum);
      var totalVests = vestingSharesNum + receivedSharesNum;
      console.log(' - - total vests: ' + totalVests);

      var steempower = lib.getSteemPowerFromVest(totalVests);
      // console.log('steem power: ' + steempower);
      var spScaledVests = steempower / steemPerVest;
      // console.log('spScaledVests: ' + spScaledVests);

      var oneval = ((item.self_vote_payout * 100) / (spScaledVests * 100 * rewardPool * sbdPerSteem)) * 42;
      // console.log('oneval: ' + oneval);

      var votingpower = (oneval / (100 * (100 * vp) / lib.VOTE_POWER_1_PC)) * 100;
      // console.log('voting power: ' + votingpower);

      if (votingpower > 100) {
        votingpower = 100;
        // console.log('capped voting power to 100%');
      }

      var counterPercentage = -votingpower;

      // console.log('countering percentage: ' + counterPercentage);

      var counterPcInt = parseInt(counterPercentage.toFixed(2) * lib.VOTE_POWER_1_PC);

      console.log('countering percentage int: ' + counterPcInt);
      console.log('Voting...');
      var restricted = false;
      if (lib.getTestAuthorList() !== null &&
          lib.getTestAuthorList() !== undefined &&
          lib.getTestAuthorList().length > 0) {
        restricted = true;
        for (var m = 0; m < lib.getTestAuthorList().length; m++) {
          if (voter.localeCompare(lib.getTestAuthorList()[m]) === 0) {
            restricted = false;
            break;
          }
        }
      }
      if (!restricted) {
        if (process.env.ACTIVE !== undefined &&
            process.env.ACTIVE !== null &&
            process.env.ACTIVE.localeCompare('true') === 0) {
          try {
            var voteResult = wait.for(steem.broadcast.vote,
              process.env.POSTING_KEY_PRV,
              process.env.STEEM_USER,
              voter,
              item.permlink,
              counterPcInt);
            // pc to
            // Steem scaling
            console.log('Vote result: ' + JSON.stringify(voteResult));
          } catch (err) {
            console.log('Error voting: ' + JSON.stringify(err));
            // callback();
            // return;
            continue;
          }
          console.log('Wait 3.5 seconds to allow vote limit to' +
            ' reset');
          wait.for(lib.timeout_wrapper, 3500);
          console.log('Finished waiting');
        } else {
          console.log('Bot not in active state, not voting');
        }
      } else {
        console.log('Not voting, author restriction list not' +
          ' met');
      }
    }
    // update db
    console.log('update db');
    /*
    lib.mongo_dropQueue_wrapper();
    for (var i = 1; i < queue.length; i++) {
      wait.for(lib.mongoSave_wrapper, lib.DB_QUEUE, queue[i]);
    }
    */
    wait.for(lib.mongoRemove_wrapper, lib.DB_QUEUE, queue[0]);
    callback();
  });
}

function recalcVotingPower (latestBlockMoment) {
  // update account
  var accounts = wait.for(lib.steem_getAccounts_wrapper, process.env.STEEM_USER);
  var account = accounts[0];
  if (account === null || account === undefined) {
    console.log('Could not get bot account detail');
    return 0;
  }
  lib.setAccount(accounts[0]);
  var vp = account.voting_power;
  // console.log(' - - bot vp: '+vp);
  // last_vote_time = Time.parse(r['last_vote_time'] + 'Z')
  var lastVoteTime = moment(account.last_vote_time);
  // console.log(' - - lastVoteTime: '+lastVoteTime);
  // now_time = Time.parse(@latest_block['timestamp'] + 'Z')
  // console.log(' - - latestBlockMoment(supplied): '+latestBlockMoment);
  var secondsDiff = (latestBlockMoment.valueOf() - lastVoteTime.valueOf()) / 1000;
  // console.log(' - - secondsDiff: '+secondsDiff);
  if (secondsDiff > 0) {
    var vpRegenerated = secondsDiff * 10000 / 86400 / 5;
    // console.log(' - - vpRegenerated: '+vpRegenerated);
    vp += vpRegenerated;
    // console.log(' - - new vp: '+vp);
  } else {
    // console.log(' - - - negative seconds diff, do not use');
  }
  if (vp > 10000) {
    vp = 10000;
  }
  console.log(' - - new vp(corrected): ' + vp);
  return vp;
}

// START THIS SCRIPT
main();
