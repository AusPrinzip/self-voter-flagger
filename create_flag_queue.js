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
    var pendingRewardedVestingSharesParts = lib.getProperties().pending_rewarded_vesting_shares.split(" ");
    var pendingRewardedVestingSharesNum = Number(pendingRewardedVestingSharesParts[0]);
    var pendingRewardedVestingSteemParts = lib.getProperties().pending_rewarded_vesting_steem.split(" ");
    var pendingRewardedVestingSteemNum = Number(pendingRewardedVestingSteemParts[0]);
    var steemPerRshare = pendingRewardedVestingSteemNum / pendingRewardedVestingSharesNum;
    doProcess(steemPerRshare, function () {
      console.log("Finished");
    });
  });
}


function doProcess(steemPerRshare, callback) {
  wait.launchFiber(function() {
    var voters = wait.for(lib.getAllVoters);
    var posts = [];
    console.log("processing...");
    for (var i = 0 ; i < voters.length ; i++) {
      console.log(" - voter: "+voters[i].voter);
      if (voters[i].selfvotes_detail_daily.length > 0) {
        for (var j = 0 ; j < voters[i].selfvotes_detail_daily.length ; j++) {
          console.log(" - - self vote "+j);
          var toAdd = false;
          if (posts.length >= 4) {
            for (var k = 0 ; k < 4 ; k++) {
              if (posts[k].rshares < voters[i].selfvotes_detail_daily[j].rshares) {
                posts = posts.splice(k, 1);
                toAdd = true;
                console.log(" - - - removing post "+posts[k].permlink+" at rhsares "+posts[k].rshares);
                break;
              }
            }
          } else {
            console.log(" - - - less than 4 posts");
            toAdd = true;
          }

          if (toAdd) {
            var post = {
              author: voters[i].voter,
              permlink: voters[i].selfvotes_detail_daily[j].permlink,
              rshares: voters[i].selfvotes_detail_daily[j].rshares,
              rsteem: steemPerRshare * voters[i].selfvotes_detail_daily[j].rshares
            };
            console.log(" - - - adding "+JSON.stringify(post));
            posts.push();
          }
          // copy daily to weekly stats (will be wiped afterward)
          voters[i].selfvotes_detail_weekly.push(voters[i].selfvotes_detail_daily[j]);
        }
        voters[i].selfvotes_detail_daily = []; //reset daily permlink
      } else {
        console.log(" - doesnt have votes, skipping");
      }
    }

    console.log(" RESULTS: "+JSON.stringify(posts));

    /*
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
    */
    callback();
  });
}

// START THIS SCRIPT
main();