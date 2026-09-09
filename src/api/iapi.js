import { getIpFromHeader } from "../util/util.js"

/* Helper function for reading a posted JSON body */
function readJson(res, cb, err) {
  let buffer;
  /* Register data cb */
  res.onData((ab, isLast) => {
    let chunk = Buffer.from(ab);
    if (isLast) {
      let json;
      if (buffer) {
        try {
          json = JSON.parse(Buffer.concat([buffer, chunk]));
        } catch (e) {
          /* res.close calls onAborted */
          res.close();
          return;
        }
        cb(json);
      } else {
        try {
          json = JSON.parse(chunk);
        } catch (e) {
          /* res.close calls onAborted */
          res.close();
          return;
        }
        cb(json);
      }
    } else {
      if (buffer) {
        buffer = Buffer.concat([buffer, chunk]);
      } else {
        buffer = Buffer.concat([chunk]);
      }
    }
  });

  /* Register error cb */
  res.onAborted(err);
}

export function handleIapiRequest(server, res, req) {
  try {
    let url = req.getUrl()
    if (url.length > 1 && url.endsWith("/")) url = url.substring(0, url.length - 1)
    switch (url) {
      case "/iapi/payment":
        handlePayment(server, res, req)
        return
      default:
        res.end('"Unknown request"')
    }
  } catch (error) {
    console.log(error)
  }
}

function handlePayment(server, res, req) {
  readJson(res, j => {
    try {
      if (!j || typeof j !== 'object') {
        res.end("no");
        return;
      }

      //console.log("payment received " + JSON.stringify(j));

      let id = j.id || "";
      let world = j.world || "main";
      let pid = j.player || 0;
      let amount = j.amount || 0.0;
      let memo = j.memo || "";

      if (id === "" || amount === 0.0) {
        res.end();
        return;
      }

      // Get client from world manager
      let { valid, client } = server.worlds.getClientFrom(world, pid);

      console.log("Donation received id=" + id + " w=" + world + " a=" + amount + " m=" + memo);
      server.handleDonation(id, valid ? world : "", client, amount, memo);
      res.end();
    } catch (error) {
      console.error("Error processing payment:", error);
      res.end("no");
    }
  }, () => {
    console.error("couldn't read donation request body");
  })
}
