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
    doProcess(lib.getLastInfos().lastBlock + 1, function () {
      console.log("Finished");
    });
  });
}

var posts = [];

function doProcess(startAtBlockNum, callback) {
  wait.launchFiber(function() {
    var totalVotes = 0;
    var numSelfVotes = 0;
    var numSelfComments = 0;
    var numSelfVotesToProcess = 0;
    var numFlagsToCancel = 0;
    var firstBlockMoment = null;
    var currentBlockNum = 0;
    for (var i = startAtBlockNum; i <= lib.getProperties().head_block_number; i++) {
      currentBlockNum = i;
      var block = wait.for(lib.steem_getBlock_wrapper, i);
      // create current time moment from block infos
      var latestBlockMoment = moment(block. timestamp, moment.ISO_8601);
      if (firstBlockMoment === null) {
        firstBlockMoment = latestBlockMoment;
      } else {
        if (firstBlockMoment.dayOfYear() < latestBlockMoment.dayOfYear()) {
          // exit, the have processed entire day
          currentBlockNum--;
          break;
        }
      }
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
              content = wait.for(lib.steem_getContent_wrapper, opDetail.author,
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
              var accounts = wait.for(lib.steem_getAccounts_wrapper, opDetail.voter);
              var voterAccount = accounts[0];
              // TODO : take delegated stake into consideration?
              var steemPower = lib.getSteemPowerFromVest(voterAccount.vesting_shares);
              if (steemPower < lib.MIN_SP) {
                console.log("SP of "+opDetail.voter+" < min of "+lib.MIN_SP
                  +", skipping");
                continue;
              }

              // check voter db for same vote
              var voterInfos = wait.for(lib.getVoterFromDb, opDetail.voter);

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
                var pending_payout_value = content.pending_payout_value.split(" ");
                var pending_payout_value_NUM = Number(pending_payout_value);
                var self_vote_payout = pending_payout_value_NUM * (voteDetail.rshares / Number(content.vote_rshares));

                // update voter info
                var selfVoteObj =  {
                  permlink: content.permlink,
                  rshares: voteDetail.rshares,
                  self_vote_payout: self_vote_payout,
                  pending_payout_value: pending_payout_value_NUM
                };
                console.log(" - - self vote obj: "+JSON.stringify(selfVoteObj));
                if (voterInfos === null || voterInfos === undefined) {
                  voterInfos = {
                    voter: opDetail.voter,
                    selfvotes: 1,
                    selfvotes_detail_daily: [
                      selfVoteObj
                    ],
                    selfvotes_detail_weekly: [] //to be filled with daily
                    // when finished daily report
                  };
                } else {
                  voterInfos.selfvotes = voterInfos.selfvotes + 1;
                  voterInfos.selfvotes_detail_daily.push(selfVoteObj);
                }

                console.log(" - - - arranging posts "+posts.length+"...");
                if (posts.length >= 4) {
                  // first sort with lowest first
                  posts.sort(function (a, b) {
                    return a.self_vote_payout - b.self_vote_payout;
                  });
                  var lowestRshare = self_vote_payout;
                  var idx = -1;
                  for (var m = 0; m < posts.length; m++) {
                    if (posts[m].self_vote_payout < self_vote_payout
                        && posts[m].self_vote_payout < self_vote_payout) {
                      lowestRshare = posts[m].self_vote_payout;
                      idx = m;
                    }
                  }
                  if (idx >= 0) {
                    console.log(" - - - removing existing lower rshares" +
                      " post " +posts[idx].permlink+" with payout "+posts[idx].payout);
                    var newPosts = [];
                    for (var m = 0; m < posts.length; m++) {
                      if (m != idx) {
                        newPosts.push(posts[m]);
                      }
                    }
                    posts = newPosts;
                    console.log(" - - - keeping "+newPosts.length+" posts");
                  }
                }

                if (posts.length < 4) {
                  console.log(" - - - adding new post to top list");
                  posts.push(selfVoteObj);
                } else {
                  console.log(" - - - not adding post to top list");
                }
              }

              wait.for(lib.mongoSave_wrapper, lib.DB_VOTERS, voterInfos);
              console.log("* voter updated: "+JSON.stringify(voterInfos));
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
      currentBlockNum + " is "+numSelfVotes +
      ", of which "+numSelfComments+"("+numSelfVotesToProcess+" processed)"+
      " are comments out of " + totalVotes + " total votes");
    console.log(" - "+numFlagsToCancel+" previous flags cancelled");
    wait.for(lib.mongoSave_wrapper, lib.DB_RUNS,
      {
        start_block: startAtBlockNum,
        end_block: currentBlockNum,
        votes_total: totalVotes,
        selfvotes_total: numSelfVotes,
        selfvotes_comments: numSelfComments,
        selfvotes_high_sp_comments: numSelfVotesToProcess,
        flags_cancelled: numFlagsToCancel
      });
    var lastInfos = lib.getLastInfos();
    lastInfos.lastBlock = currentBlockNum;
    wait.for(lib.mongoSave_wrapper, lib.DB_RECORDS, lastInfos);
    lib.setLastInfos(lastInfos);
    // save top posts
    for (var i = 0; i < posts.length; i++) {
      wait.for(lib.mongoSave_wrapper, lib.DB_QUEUE, posts[i]);
    }
    // exit
    callback();
  });
}


// START THIS SCRIPT
main();