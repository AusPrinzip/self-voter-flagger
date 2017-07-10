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
    doReport(function (err, html) {
      sendEmail("smackdown.kitty report", html, true, function (err, data) {
        if (err) {
          console.log("Could not send email: "+err);
        } else {
          console.log("Finished successfully");
        }
      });
    });
  });
}

function doReport(callback) {
  var html = "<html><head>Self Voting Flagger - Report</head><body>";
  // basic stuff
  html += "<h3>on account @"+process.env.STEEM_USER+"</h3>";
  var runs = wait.for(getAllRuns);
  var voters = wait.for(getAllVoters);
  html += "<p>Number of runs: "+runs.length+"</p>";
  html += "<p>Number of unique comment self voters: "+voters.length+"</p>";
  // Do per day stats
  html += "<h1>Summary stats</h1>";
  html += "<table>";
  html += "<tr>";
  html += "<td>Start time (block)</td>";
  html += "<td>End time (block)</td>";
  html += "<td>Total votes</td>";
  html += "<td>Total self votes</td>";
  html += "<td>Total self voted comments</td>";
  html += "<td>Total self voted comments > 1000 SP</td>";
  html += "</tr>";
  var lastDayOfYear = -1;
  var dayCounter = 0;
  var summary = null;
  var summaries = [];
  for (var i = 0 ; i < runs.length ; i++) {
    var run = runs[i];
    var startBlockInfo = wait.for(steem_getBlockHeader_wrapper, run.start_block);
    var endBlockInfo = wait.for(steem_getBlockHeader_wrapper, run.end_block);
    var startMoment = moment(startBlockInfo.timestamp, moment.ISO_8601);
    var endMoment = moment(endBlockInfo.timestamp, moment.ISO_8601);
    if (lastDayOfYear < startMoment.dayOfYear()
        || startMoment.dayOfYear() < endMoment.dayOfYear()) {
      // first process what we have, if anything
      if (summary !== null) {
        var summaryStartMoment = moment(summary.start_time, moment.ISO_8601);
        var summaryEndMoment = moment(summary.end_time, moment.ISO_8601);
        html += "<tr>";
        html += "<td>"+summaryStartMoment.format(DATE_FORMAT)+" ("+summary.start_time+")</td>";
        html += "<td>"+summaryEndMoment.format(DATE_FORMAT)+" ("+summary.end_time+")</td>";
        html += "<td>"+summary.votes_total+"</td>";
        html += "<td>"+summary.selfvotes_total+"</td>";
        html += "<td>"+summary.selfvotes_comments+"</td>";
        html += "<td>"+summary.selfvotes_high_sp_comments+"</td>";
        html += "</tr>";
        summaries.push(summary);
      }
      // RESET DAY SUMMARY FOR NEW DAY
      dayCounter++;
      // note, we expect this first time also
      summary = {
        start_time: startBlockInfo.timestamp,
        end_time: endBlockInfo.timestamp,
        start_block: run.start_block,
        end_block: 0,
        votes_total: run.votes_total,
        selfvotes_total: run.selfvotes_total,
        selfvotes_comments: run.selfvotes_comments,
        selfvotes_high_sp_comments: run.selfvotes_high_sp_comments
      };
    } else {
      summary.end_time = endBlockInfo.timestamp; //always update so is last
      summary.votes_total += run.votes_total;
      summary.selfvotes_total += run.selfvotes_total;
      summary.selfvotes_comments += run.selfvotes_comments;
      summary.selfvotes_high_sp_comments += run.selfvotes_high_sp_comments;
    }
  }
  html += "</table>";
  html += "</body></html>";
  callback(null, html);
}



// START THIS SCRIPT
main();