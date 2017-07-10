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
    console.log("steemPerRshare: "+steemPerRshare);
    console.log("processing...");
    createQueue(steemPerRshare, function () {
      console.log("Finished");
    });
  });
}


function createQueue(steemPerRshare, callback) {
  lib.getAllVoters_reset();
  console.log("getting voters...");
  var posts = [];
  lib.getEachVoter(function (err, item) {
    if (item === null) {
      console.log("No more posts to get");
      console.log(" RESULTS: " + JSON.stringify(posts));
      wait.launchFiber(function () {
        for (var i = 0; i < posts.length; i++) {
          wait.for(lib.mongoSave_wrapper, lib.DB_QUEUE, posts[i]);
        }
        callback();
      });
    }
    console.log(" - voter: " + item.voter);
    if (item.selfvotes_detail_daily.length > 0) {
      for (var j = 0; j < item.selfvotes_detail_daily.length; j++) {
        console.log(" - - self vote " + j);
        var toAdd = false;
        if (posts.length >= 4) {
          for (var k = 0; k < posts.length; k++) {
            if (posts[k].rshares < item.selfvotes_detail_daily[j].rshares) {
              console.log(" - - - removing post " + posts[k].permlink + " at rhsares " + posts[k].rshares);
              posts = posts.splice(k, 1);
              toAdd = true;
              break;
            }
          }
        } else {
          console.log(" - - - less than 4 posts");
          toAdd = true;
        }

        if (toAdd) {
          var post = {
            author: item.voter,
            permlink: item.selfvotes_detail_daily[j].permlink,
            rshares: item.selfvotes_detail_daily[j].rshares,
            rsteem: steemPerRshare * item.selfvotes_detail_daily[j].rshares
          };
          console.log(" - - - adding " + JSON.stringify(post));
          posts.push(post);
        }
        // copy daily to weekly stats (will be wiped afterward)
        item.selfvotes_detail_weekly.push(item.selfvotes_detail_daily[j]);
      }
      item.selfvotes_detail_daily = []; //reset daily permlink
      // TODO : save item
    } else {
      console.log(" - doesnt have votes, skipping");
    }
  });
}

// START THIS SCRIPT
main();