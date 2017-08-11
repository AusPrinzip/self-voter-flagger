'use strict';

const
  steem = require("steem"),
  path = require("path"),
  mongodb = require("mongodb"),
  moment = require('moment'),
  S = require('string'),
  wait = require('wait.for'),
  lib = require('./lib.js');

const
  MAX_ITERATIONS = 50;

function main() {
  lib.start(function () {
    doProcess(function () {
      console.log("Finished");
    });
  });
}

function doProcess(callback) {
  wait.launchFiber(function() {
    // get some info first
    var headBlock = wait.for(lib.steem_getBlockHeader_wrapper, lib.getProperties().head_block_number);
    var latestBlockMoment = moment(headBlock.timestamp, moment.ISO_8601);
    // chain stuff
    var rewardfund_info = wait.for(lib.steem_getRewardFund_wrapper, "post");
    var price_info = wait.for(lib.steem_getCurrentMedianHistoryPrice_wrapper);

    var reward_balance = rewardfund_info.reward_balance;
    var recent_claims = rewardfund_info.recent_claims;
    var reward_pool = reward_balance.replace(" STEEM", "") / recent_claims;

    var sbd_per_steem = price_info.base.replace(" SBD", "") / price_info.quote.replace(" STEEM", "");

    var steem_per_vest = lib.getProperties().total_vesting_fund_steem.replace(" STEEM", "")
        / lib.getProperties().total_vesting_shares.replace(" VESTS", "");



    // get queue and sort largest self vote payout first
    var queue = wait.for(lib.getAllQueue);
    if (queue === undefined || queue === null || queue.length === 0) {
      console.log("Nothing in queue! Exiting");
      callback();
      return;
    }
    queue.sort(function (a, b) {
      return b.total_extrapolated_roi - a.total_extrapolated_roi;
    });

    var count = 0;
    for (var k = 0 ; k < queue[0].comments.length ; k++) {
      count++;
      // process ONE item
      var voter = queue[0].voter;
      var item = queue[0].comments[k];

      console.log("** processing for user: "+voter);

      // check payout window still open (only when active)
      if (process.env.ACTIVE !== undefined
        && process.env.ACTIVE !== null
        && process.env.ACTIVE.localeCompare("true") == 0) {
        var content = wait.for(lib.steem_getContent_wrapper, voter,
          item.permlink);
        if (content === undefined || content === null) {
          console.log("Couldn't get content, assuming is within payout" +
            " window");
        } else {
          var cashoutTime = moment(content.cashout_time);
          cashoutTime.subtract(7, 'hours');
          var nowTime = moment(new Date());
          if (!nowTime.isBefore(cashoutTime)) {
            console.log("payout window now closed, remove from queue and" +
              " move on :(");
            continue;
          }
        }
      }

      console.log("** processing item " + k + ": " + JSON.stringify(item));
      // update account
      var accounts = wait.for(lib.steem_getAccounts_wrapper, process.env.STEEM_USER);
      lib.setAccount(accounts[0]);
      console.log("--DEBUG CALC VOTE PERCENTAGE--");
      var vp = recalcVotingPower(latestBlockMoment);
      console.log(" - vp: " + vp);
      console.log(" - abs_percentage calc");
      console.log(" - - mAccount.vesting_shares: " + lib.getAccount().vesting_shares);
      console.log(" - - mAccount.received_vesting_shares" +
        " (delegated from others): " + lib.getAccount().received_vesting_shares);
      var vestingSharesParts = lib.getAccount().vesting_shares.split(" ");
      var vestingSharesNum = Number(vestingSharesParts[0]);
      console.log(" - - - vesting_shares num: " + vestingSharesNum);
      var receivedSharesParts = lib.getAccount().received_vesting_shares.split(" ");
      var receivedSharesNum = Number(receivedSharesParts[0]);
      console.log(" - - - received_vesting_shares num: " + receivedSharesNum);
      var totalVests = vestingSharesNum + receivedSharesNum;
      console.log(" - - total vests: " + totalVests);

      var steempower = lib.getSteemPowerFromVest(totalVests);
      //console.log("steem power: " + steempower);
      var sp_scaled_vests = steempower / steem_per_vest;
      //console.log("sp_scaled_vests: " + sp_scaled_vests);

      var oneval = ((item.self_vote_payout * 100) / (sp_scaled_vests * 100 * reward_pool * sbd_per_steem)) * 42;
      //console.log("oneval: " + oneval);

      var votingpower = (oneval / (100 * (100 * vp) / lib.VOTE_POWER_1_PC)) * 100;
      //console.log("voting power: " + votingpower);

      if (votingpower > 100) {
        votingpower = 100;
        //console.log("capped voting power to 100%");
      }

      var counter_percentage = -votingpower;

      //console.log("countering percentage: " + counter_percentage);

      var counter_pc_int = parseInt(counter_percentage.toFixed(2) * lib.VOTE_POWER_1_PC);

      console.log("countering percentage int: " + counter_pc_int);
      console.log("Voting...");
      var restricted = false;
      if (lib.getTestAuthorList() !== null
        && lib.getTestAuthorList() !== undefined
        && lib.getTestAuthorList().length > 0) {
        restricted = true;
        for (var m = 0; m < lib.getTestAuthorList().length; m++) {
          if (voter.localeCompare(lib.getTestAuthorList()[m]) === 0) {
            restricted = false;
            break;
          }
        }
      }
      if (!restricted) {
        if (process.env.ACTIVE !== undefined
          && process.env.ACTIVE !== null
          && process.env.ACTIVE.localeCompare("true") == 0) {
          try {
            var voteResult = wait.for(steem.broadcast.vote,
              process.env.POSTING_KEY_PRV,
              process.env.STEEM_USER,
              voter,
              item.permlink,
              counter_pc_int);
            // pc to
            // Steem scaling
            console.log("Vote result: " + JSON.stringify(voteResult));
          } catch (err) {
            console.log("Error voting: " + JSON.stringify(err));
            //callback();
            //return;
            continue;
          }
          console.log("Wait 3.5 seconds to allow vote limit to" +
            " reset");
          wait.for(lib.timeout_wrapper, 3500);
          console.log("Finished waiting");
        } else {
          console.log("Bot not in active state, not voting");
        }
      } else {
        console.log("Not voting, author restriction list not" +
          " met");
      }
    }
    // update db
    console.log("update db");
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

function recalcVotingPower(latestBlockMoment) {
  // update account
  var accounts = wait.for(lib.steem_getAccounts_wrapper, process.env.STEEM_USER);
  var account = accounts[0];
  if (account === null || account === undefined) {
    console.log("Could not get bot account detail");
    return 0;
  }
  lib.setAccount(accounts[0]);
  var vp = account.voting_power;
  //console.log(" - - bot vp: "+vp);
  //last_vote_time = Time.parse(r["last_vote_time"] + 'Z')
  var lastVoteTime = moment(account.last_vote_time);
  //console.log(" - - lastVoteTime: "+lastVoteTime);
  //now_time = Time.parse(@latest_block["timestamp"] + 'Z')
  //console.log(" - - latestBlockMoment(supplied): "+latestBlockMoment);
  var secondsDiff = (latestBlockMoment.valueOf() - lastVoteTime.valueOf()) / 1000;
  //console.log(" - - secondsDiff: "+secondsDiff);
  if (secondsDiff > 0) {
    var vpRegenerated = secondsDiff * 10000 / 86400 / 5;
    //console.log(" - - vpRegenerated: "+vpRegenerated);
    vp += vpRegenerated;
    //console.log(" - - new vp: "+vp);
  } else {
    //console.log(" - - - negative seconds diff, do not use");
  }
  if (vp > 10000) {
    vp = 10000;
  }
  console.log(" - - new vp(corrected): "+vp);
  return vp;
}


// START THIS SCRIPT
main();