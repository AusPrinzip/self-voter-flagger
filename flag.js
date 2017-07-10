'use strict';

const
  steem = require("steem"),
  path = require("path"),
  mongodb = require("mongodb"),
  moment = require('moment'),
  S = require('string'),
  wait = require('wait.for'),
  lib = require('./lib.js');

function main() {
  lib.start(function () {
    doProcess(mLastInfos.lastBlock + 1, function () {
      console.log("Finished");
    });
  });
}


function doProcess(startAtBlockNum, callback) {
  wait.launchFiber(function() {
    var totalVotes = 0;
    var numSelfVotes = 0;
    var numSelfComments = 0;
    var numSelfVotesToProcess = 0;
    var numFlagsToCancel = 0;
    for (var i = startAtBlockNum; i <= mProperties.head_block_number; i++) {
      var block = wait.for(steem_getBlock_wrapper, i);
      // create current time moment from block infos
      var latestBlockMoment = moment(block. timestamp, moment.ISO_8601);
      //console.log("block info: "+JSON.stringify(block));
      var transactions = block.transactions;
      for (var j = 0; j < transactions.length; j++) {
        var transaction = transactions[j];
        for (var k = 0 ; k < transaction.operations.length ; k++) {
          var opName = transaction.operations[k][0];
          var opDetail = transaction.operations[k][1];
          //try {
          if (opName !== undefined && opName !== null
            && opName.localeCompare("vote") == 0) {

            totalVotes++;

            // check vote is a self vote
            if (opDetail.voter.localeCompare(opDetail.author) != 0) {
              continue;
            }
            numSelfVotes++;

            console.log("- self vote at b " + i + ":t " + j + ":op " +
              k + ", detail:" + JSON.stringify(opDetail));

            // FIRST, screen for comments only
            var permlinkParts = opDetail.permlink.split("-");
            if (permlinkParts.length === 0
              || !moment(permlinkParts[permlinkParts.length - 1], "YYYYMMDDtHHmmssSSSz").isValid()) {
              console.log("Not a comment, skipping")
              continue;
            }

            // THIRD, get rshares of vote from post
            var content;
            // TODO : cache posts
            content = wait.for(steem_getContent_wrapper, opDetail.author,
              opDetail.permlink);
            if (content === undefined || content === null) {
              console.log("Couldn't process operation, continuing." +
                " Error: post content response not defined");
              continue;
            }
            var voteDetail = null;
            for (var m = 0; m < content.active_votes.length; m++) {
              if (content.active_votes[m].voter.localeCompare(opDetail.voter) == 0) {
                voteDetail = content.active_votes[m];
                break;
              }
            }
            if (voteDetail === null) {
              console.log("vote details null, cannot process, skip");
              continue;
            }

            // FOURTH, check if vote rshares are > 0, cancelled self votes
            // have rshares == 0
            if (voteDetail.rshares < 0) {
              console.log(" - - self flag");
            } else if (voteDetail.rshares === 0) {
              console.log(" - - self vote negated");
            } else {
              // is a self voted comment
              numSelfComments++;
            }

            // SECOND, check their SP
            // TODO : cache user accounts
            var accounts = wait.for(steem_getAccounts_wrapper, opDetail.voter);
            var voterAccount = accounts[0];
            // TODO : take delegated stake into consideration?
            var steemPower = getSteemPowerFromVest(voterAccount.vesting_shares);
            if (steemPower < MIN_SP) {
              console.log("SP of "+opDetail.voter+" < min of "+MIN_SP
                +", skipping");
              continue;
            }

            // check voter db for same vote
            var voterInfos = wait.for(getVoterFromDb, opDetail.voter);

            var toContinue = false;

            // check if we already have a record of this
            if (voterInfos !== null && voterInfos !== undefined) {
              // TODO : check self vote negation against week long list
              if (voterInfos.hasOwnProperty("selfvotes_detail_daily")
                && voterInfos.selfvotes_detail_daily.length > 0) {
                for (var m = 0; m < voterInfos.selfvotes_detail_daily.length; m++) {
                  if (content.permlink.localeCompare(voterInfos.selfvotes_detail_daily[m].permlink) === 0) {
                    console.log(" - permlink " + content.permlink + " already noted as self vote");
                    console.log(" - rshares changed from "
                      + voterInfos.selfvotes_detail_daily[m].rshares
                      +" to "+ voteDetail.rshares);
                    voterInfos.selfvotes_detail_daily[m].rshares = voteDetail.rshares;
                    // already exists, figure out what the update is
                    if (voterInfos.selfvotes_detail_daily[m].rshares > 0
                      && voteDetail.rshares <= 0) {
                      // user canceled a self vote
                      // remove self vote from db
                      console.log(" - - remove this post from db, no" +
                        " longer self vote");
                      voterInfos.selfvotes_detail_daily = voterInfos.selfvotes_detail_daily.splice(m, 1);
                    }
                    toContinue = true;
                    break;
                  }
                }
              }
            }

            if (!toContinue) {
              numSelfVotesToProcess++;

              // update voter info
              if (voterInfos === null || voterInfos === undefined) {
                voterInfos = {
                  voter: opDetail.voter,
                  selfvotes: 1,
                  selfvotes_detail_daily: [
                    {
                      permlink: content.permlink,
                      rshares: voteDetail.rshares
                    }
                  ],
                  selfvotes_detail_weekly: [] //to be filled with daily
                  // when finished daily report
                };
              } else {
                voterInfos.selfvotes = voterInfos.selfvotes + 1;
                voterInfos.selfvotes_detail_daily.push(
                  {
                    permlink: content.permlink,
                    rshares: voteDetail.rshares
                  }
                );
              }
            }

            wait.for(mongoSave_wrapper, DB_VOTERS, voterInfos);
            console.log("* voter updated: "+JSON.stringify(voterInfos));

            // TODO : move this to flagging rountine
            /*
             console.log("--DEBUG CALC VOTE PERCENTAGE--");
             var abs_need_rshares = Math.abs(voteDetail.rshares);
             console.log(" - abs_need_rshares: "+abs_need_rshares);
             var vp = recalcVotingPower(latestBlockMoment);
             console.log(" - vp: "+vp);
             // note, these constants are not fully understood
             // the _50_ constant was 200, and could possibly be better at 40
             // TODO : confirm constants are correct
             // TODO : take delegated stake into consideration?
             console.log(" - abs_percentage calc");
             console.log(" - - mAccount.vesting_shares: "+mAccount.vesting_shares);
             console.log(" - - mAccount.received_vesting_shares" +
             " (delegated from others): "+mAccount.received_vesting_shares);
             var vestingSharesParts = mAccount.vesting_shares.split(" ");
             var vestingSharesNum = Number(vestingSharesParts[0]);
             console.log(" - - vesting_shares num: "+vestingSharesNum);
             var receivedSharesParts = mAccount.received_vesting_shares.split(" ");
             var receivedSharesNum = Number(receivedSharesParts[0]);
             console.log(" - - received_vesting_shares num: "+receivedSharesNum);
             var abs_percentage = (abs_need_rshares * 10000 * 100 * 200 / vp / (vestingSharesNum + receivedSharesNum));
             console.log(" - abs_percentage: "+abs_percentage);
             if (abs_percentage > 100) {
             abs_percentage = 100;
             }
             console.log(" - abs_percentage(corrected) : "+abs_percentage);

             var abs_counter_percentage = voterInfos.selfvotes;
             console.log(" - abs_counter_percentage: "+abs_counter_percentage);
             if (abs_counter_percentage > 100) {
             abs_counter_percentage = 100;
             console.log(" - abs_counter_percentage(fixed): "+abs_counter_percentage);
             }
             if (abs_counter_percentage > abs_percentage) {
             console.log(" - abs_counter_percentage(bounded): "+abs_counter_percentage);
             }
             var counter_percentage = !toCancelFlag ? -abs_counter_percentage : abs_counter_percentage;
             console.log("countering percentage: "+counter_percentage);
             console.log("Voting...");
             var restricted = false;
             if (mTestAuthorList !== null
             && mTestAuthorList !== undefined
             && mTestAuthorList.length > 0) {
             restricted = true;
             for (var m = 0 ; m < mTestAuthorList.length ; m++) {
             if (opDetail.voter.localeCompare(mTestAuthorList[m]) === 0) {
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
             content.author,
             content.permlink,
             (counter_percentage * VOTE_POWER_1_PC)); // adjust pc to Steem scaling
             console.log("Vote result: "+JSON.stringify(voteResult));
             console.log("Wait 3.5 seconds to allow vote limit to" +
             " reset");
             var timeoutResult = wait.for(timeout_wrapper, 3500);
             console.log("Finished waiting");
             } catch(err) {
             console.log("Error voting: "+JSON.stringify(err));
             }
             } else {
             console.log("Bot not in active state, not voting");
             }
             } else {
             console.log("Not voting, author restriction list not" +
             " met");
             }
             */
          }
          /*
           } catch (err) {
           console.log("Couldn't process operation, continuing. Error: "
           + JSON.stringify(err));
           continue;
           }
           */
        }
      }
    }
    console.log("NUM SELF VOTES from block "+startAtBlockNum+" to " +
      mProperties.head_block_number + " is "+numSelfVotes +
      ", of which "+numSelfComments+"("+numSelfVotesToProcess+" processed)"+
      " are comments out of " + totalVotes + " total votes");
    console.log(" - "+numFlagsToCancel+" previous flags cancelled");
    wait.for(mongoSave_wrapper, DB_RUNS,
      {
        start_block: startAtBlockNum,
        end_block: mProperties.head_block_number,
        votes_total: totalVotes,
        selfvotes_total: numSelfVotes,
        selfvotes_comments: numSelfComments,
        selfvotes_high_sp_comments: numSelfVotesToProcess,
        flags_cancelled: numFlagsToCancel
      });
    mLastInfos.lastBlock = mProperties.head_block_number;
    wait.for(mongoSave_wrapper, DB_RECORDS, mLastInfos);
    callback();
  });
}

function recalcVotingPower(latestBlockMoment) {
  // update account
  var accounts = wait.for(steem_getAccounts_wrapper, process.env.STEEM_USER);
  var account = accounts[0];
  if (account === null || account === undefined) {
    console.log("Could not get bot account detail")
    return 0;
  }
  lib.setAccount(accounts[0]);
  var vp = account.voting_power;
  console.log(" - - bot vp: "+vp);
  //last_vote_time = Time.parse(r["last_vote_time"] + 'Z')
  var lastVoteTime = moment(account.last_vote_time);
  console.log(" - - lastVoteTime: "+lastVoteTime);
  //now_time = Time.parse(@latest_block["timestamp"] + 'Z')
  console.log(" - - latestBlockMoment(supplied): "+latestBlockMoment);
  var secondsDiff = latestBlockMoment.seconds() - lastVoteTime.seconds();
  console.log(" - - secondsDiff: "+secondsDiff);
  if (secondsDiff > 0) {
    var vpRegenerated = secondsDiff * 10000 / 86400 / 5;
    console.log(" - - vpRegenerated: "+vpRegenerated);
    vp += vpRegenerated;
    console.log(" - - new vp: "+vp);
  } else {
    console.log(" - - - negative seconds diff, do not use");
  }
  if (vp > 10000) {
    vp = 10000;
  }
  console.log(" - - new vp(corrected): "+vp);
  return vp;
}


// START THIS SCRIPT
main();