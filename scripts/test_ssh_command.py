import subprocess

def run_remote_command(host, username, command):
    """
    Run a command on a remote host via SSH and return the output
    """
    try:
        # Use list format to avoid shell escaping issues on Windows
        ssh_args = [
            'ssh',
            f'{username}@{host}',
            command
        ]
        
        print(f"Running: ssh {username}@{host} {command}\n")
        
        # Execute command
        result = subprocess.run(
            ssh_args,
            capture_output=True,
            text=True,
            shell=False  # Don't use shell to avoid Windows escaping issues
        )
        
        # Check for errors
        if result.returncode == 0:
            print("✓ Command executed successfully\n")
            print("Output:")
            print(result.stdout)
            return result.stdout
        else:
            print("✗ Command failed\n")
            print("Error:")
            print(result.stderr)
            return None
            
    except Exception as e:
        print(f"Exception: {e}")
        return None

# Test with the host
if __name__ == "__main__":
    host = "tscided0307131.sc.intel.com"
    username = "rahmanma"
    
    # Test 1: Simple whoami command
    print("=" * 50)
    print("TEST 1: whoami")
    print("=" * 50)
    run_remote_command(host, username, "whoami")
    
    # Test 2: Check hostname
    print("\n" + "=" * 50)
    print("TEST 2: hostname")
    print("=" * 50)
    run_remote_command(host, username, "hostname")
    
    # Test 3: List files in home directory
    print("\n" + "=" * 50)
    print("TEST 3: List home directory")
    print("=" * 50)
    run_remote_command(host, username, "ls ~")
