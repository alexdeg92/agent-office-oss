# Homebrew formula for Agent Office.
# sha256 is the packed tarball for 1.3.0.
# packaging/release.sh writes it. The script does not publish.
class AgentOffice < Formula
  desc "Dashboard for a self-hosted agent runtime"
  homepage "https://github.com/alexdeg92/agent-office-oss"
  url "https://github.com/alexdeg92/agent-office-oss/releases/download/v1.3.0/alexdeg92-agent-office-1.3.0.tgz"
  sha256 "74282787c0b53f87eb8832dfa7a0eb47378932fa0e7d64a4c6a2770f4e042df5"

  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir[libexec/"bin/*"]

    data_dir = var/"lib/agent-office"
    node_bin = Formula["node"].opt_bin
    script = bin/"agent-office-service"
    script.write <<~SH
      #!/bin/bash
      set -euo pipefail
      export PATH="#{node_bin}:$PATH"
      AO="#{opt_bin}/agent-office"
      export AO_DATA_DIR="${AO_DATA_DIR:-#{data_dir}}"
      mkdir -p "$AO_DATA_DIR"
      env_file="${AO_ENV_FILE:-${HOME}/.config/agent-office.env}"
      if [[ -f "$env_file" ]]; then
        set -a
        # shellcheck disable=SC1090
        source "$env_file"
        set +a
      fi
      # keep_alive below restarts the dedicated API exit status (75).
      export AO_RESTART_POLICY=always
      exec "$AO" start --host 127.0.0.1 --port 18789 --data "$AO_DATA_DIR"
    SH
    script.chmod 0755
  end

  service do
    run [opt_bin/"agent-office-service"]
    keep_alive true
    working_dir var
    log_path var/"log/agent-office.log"
    error_log_path var/"log/agent-office-error.log"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/agent-office version")
    output = shell_output("#{bin}/agent-office check-config", 1)
    assert_match "PORTAL_SECRET: missing", output
    assert_predicate bin/"agent-office-service", :executable?
  end
end
